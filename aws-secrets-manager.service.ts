import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import {PrismaService} from '@framework/prisma/prisma.service';
import {exec} from 'child_process';
import * as path from 'path';
import {promisify} from 'util';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  UpdateSecretCommand,
  DescribeSecretCommand,
  DeleteSecretCommand,
  RotateSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import {SecretType} from '@generated/prisma/client';

const execAsync = promisify(exec);

@Injectable()
export class AwsSecretsManagerService {
  private activeDeployments = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new Secret
   */
  async createSecret(params: {
    name: string;
    description?: string;
    type: SecretType;
    region?: string;
    rotationEnabled?: boolean;
    rotationRules?: {AutomaticallyAfterDays: number};
    secretValue: Record<string, any>;
    secretGroupId: string;
  }) {
    const {secretGroupId, name, type, secretValue, description, rotationEnabled, rotationRules, region} = params;

    // Get Project Config
    const secretGroup = await this.getReadySecretGroup(secretGroupId);
    const client = this.getClient(secretGroup, region);
    const lambdaArn = rotationEnabled ? secretGroup.rotationLambdaArn : undefined;

    // Validate rotation prerequisites
    if (rotationEnabled) {
      if (!this.isRotationSupported(type)) {
        throw new BadRequestException(`Secret type ${type} does not support automatic rotation`);
      }
      if (!lambdaArn) {
        throw new BadRequestException('Lambda ARN is not configured in Project Settings, cannot enable rotation');
      }
    }

    // Check name uniqueness in database
    const existing = await this.prisma.secret.findUnique({where: {name_groupId: {name, groupId: secretGroupId}}});
    if (existing) {
      throw new ConflictException(`Secret name "${name}" already exists`);
    }

    // Check if secret already exists in AWS
    try {
      await client.send(new DescribeSecretCommand({SecretId: name}));
      throw new ConflictException(`AWS Secrets Manager already contains a secret named "${name}"`);
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') {
        // If error is ANYTHING other than Not Found, rethrow it
        // If logic reaches here (no error), it means it exists, so the try block handled it?
        // Wait, DescribeSecret throws if NOT found.
        // If it DOES NOT throw, it exists.
        if (error instanceof ConflictException) throw error;
        throw error;
      }
      // If ResourceNotFoundException, we are good to go
    }

    let arn: string;
    let awsSecretCreated = false;

    try {
      // Create AWS Secret
      const createCommand = new CreateSecretCommand({
        Name: name,
        Description: description,
        SecretString: JSON.stringify(secretValue),
      });

      const result = await client.send(createCommand);
      arn = result.ARN!;
      awsSecretCreated = true;

      // Enable rotation if requested
      if (rotationEnabled) {
        try {
          await this.rotationEnabled({
            client,
            secretId: name,
            lambdaArn: lambdaArn!,
            rotationRules: rotationRules || {AutomaticallyAfterDays: 30},
          });
        } catch (rotationError) {
          // Rollback: Delete the created AWS Secret
          await client.send(
            new DeleteSecretCommand({
              SecretId: name,
              ForceDeleteWithoutRecovery: true,
            })
          );
          throw new BadRequestException(`Failed to enable rotation: ${rotationError.message}`);
        }
      }

      // Save metadata to database
      const dbRecord = await this.prisma.secret.create({
        data: {
          name,
          description,
          type,
          arn,
          region,
          rotationEnabled: rotationEnabled || false,
          rotationLambdaArn: rotationEnabled ? lambdaArn : null,
          rotationRules: rotationRules ? (rotationRules as any) : null,
          groupId: secretGroupId,
        },
      });

      return dbRecord;
    } catch (error) {
      // If database save fails but AWS Secret was created, rollback is needed
      if (awsSecretCreated && error.code !== 'P2002') {
        // P2002 is Prisma unique constraint violation error
        try {
          await client.send(
            new DeleteSecretCommand({
              SecretId: name,
              ForceDeleteWithoutRecovery: true,
            })
          );
        } catch (rollbackError) {}
      }
      throw error;
    }
  }

  /**
   * Get complete Secret information (including secret value)
   */
  async getSecretWithValue(secretId: string) {
    const secret = await this.prisma.secret.findUniqueOrThrow({
      where: {id: secretId},
    });

    // Get Project Config
    const secretGroup = await this.getReadySecretGroup(secret.groupId);
    const client = this.getClient(secretGroup, secret.region);

    // Fetch current version from AWS (AWSCURRENT)
    let secretValue: Record<string, any>;
    try {
      const command = new GetSecretValueCommand({
        SecretId: secret.name,
        VersionStage: 'AWSCURRENT', // Always fetch current version
      });
      const response = await client.send(command);

      if (response.SecretString) {
        secretValue = JSON.parse(response.SecretString);
      } else if (response.SecretBinary) {
        const buff = Buffer.from(response.SecretBinary);
        secretValue = JSON.parse(buff.toString('utf-8'));
      } else {
        secretValue = {};
      }
    } catch (error) {
      throw new BadRequestException(`Failed to get Secret from AWS Secrets Manager: ${error.message}`);
    }

    return {
      id: secret.id,
      name: secret.name,
      type: secret.type,
      arn: secret.arn,
      region: secret.region,
      description: secret.description,
      rotationEnabled: secret.rotationEnabled,
      rotationLambdaArn: secret.rotationLambdaArn,
      rotationRules: secret.rotationRules,
      lastRotatedAt: secret.lastRotatedAt,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
      secretValue,
    };
  }

  /**
   * Update Secret
   */
  async updateSecret(secretId: string, updateData: {secretValue?: Record<string, any>; description?: string}) {
    const secret = await this.prisma.secret.findUnique({
      where: {id: secretId},
    });

    if (!secret) {
      throw new NotFoundException(`Secret not found: ${secretId}`);
    }

    const {secretValue, description} = updateData;

    // Get Project Config
    const secretGroup = await this.getReadySecretGroup(secret.groupId);
    const client = this.getClient(secretGroup, secret.region);

    // Update AWS Secret
    try {
      if (secretValue) {
        const updateCommand = new UpdateSecretCommand({
          SecretId: secret.name,
          SecretString: JSON.stringify(secretValue),
          Description: description,
        });
        await client.send(updateCommand);
      }
    } catch (error) {
      throw new BadRequestException(`Failed to update AWS Secret: ${error.message}`);
    }

    // Update local database metadata
    return await this.prisma.secret.update({
      where: {id: secretId},
      data: {
        description,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Delete Secret
   */
  async deleteSecret(secretId: string, forceDelete = false) {
    const secret = await this.prisma.secret.findUnique({
      where: {id: secretId},
    });

    if (!secret) {
      throw new NotFoundException(`Secret not found: ${secretId}`);
    }

    // Get Project Config to delete from AWS
    // Note: If project config is invalid, we might fail to delete from AWS but still delete from DB?
    // It's safer to try-catch the config retrieval too.
    let client: SecretsManagerClient | null = null;
    try {
      const secretGroup = await this.getReadySecretGroup(secret.groupId);
      client = this.getClient(secretGroup, secret.region);
    } catch (e) {}

    // Delete AWS Secret
    if (client) {
      try {
        const deleteCommand = new DeleteSecretCommand({
          SecretId: secret.name,
          ForceDeleteWithoutRecovery: forceDelete,
          RecoveryWindowInDays: forceDelete ? undefined : 30,
        });

        await client.send(deleteCommand);
      } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
          // AWS Secret does not exist, only delete local record
        } else {
          // We might still want to delete local record if AWS delete fails?
          // Usually yes if we want to clean up ghost records.
        }
      }
    }

    // Delete local record
    return await this.prisma.secret.delete({
      where: {id: secretId},
    });
  }

  /**
   * Manually trigger rotation
   */
  async rotateSecret(secretId: string) {
    const secret = await this.prisma.secret.findUnique({
      where: {id: secretId},
    });

    if (!secret) {
      throw new NotFoundException(`Secret not found: ${secretId}`);
    }

    if (!secret.rotationEnabled) {
      throw new BadRequestException('This Secret does not have automatic rotation enabled');
    }

    // Get Project Config
    const secretGroup = await this.getReadySecretGroup(secret.groupId);
    const client = this.getClient(secretGroup, secret.region);

    try {
      const rotateCommand = new RotateSecretCommand({
        SecretId: secret.name,
      });

      const result = await client.send(rotateCommand);

      // Update local record
      await this.prisma.secret.update({
        where: {id: secretId},
        data: {lastRotatedAt: new Date()},
      });

      return result;
    } catch (error) {
      throw new BadRequestException(`Failed to rotate Secret: ${error.message}`);
    }
  }

  /**
   * Enable Rotation (private method)
   */
  private async rotationEnabled(params: {
    client: SecretsManagerClient;
    secretId: string;
    lambdaArn: string;
    rotationRules: {AutomaticallyAfterDays: number};
  }) {
    const {client, secretId, lambdaArn, rotationRules} = params;

    const rotateCommand = new RotateSecretCommand({
      SecretId: secretId,
      RotationLambdaARN: lambdaArn,
      RotationRules: rotationRules,
    });

    return await client.send(rotateCommand);
  }

  /**
   * Check if AWS Secret exists
   */
  async isExistingInAws(name: string, region?: string): Promise<boolean> {
    // Checking requires client, which requires secretGroupId, but check is usually done before creation
    // We can't check without project config.
    // Refactoring createSecret to do check internally after fetching config.
    // This public method might be problematic if called from outside with just name.
    // For now, removing public access or assuming it's only used inside createSecret which has project context.
    return false; // Placeholder, logic moved inside createSecret
  }

  /**
   * Deploy Rotation Lambda using SST
   */
  async deployRotationLambda(secretGroupId: string) {
    if (this.activeDeployments.has(secretGroupId)) {
      throw new ConflictException('Deployment/Removal already in progress.');
    }

    // Validate project existence before starting background task
    const project = await this.prisma.project.findUniqueOrThrow({where: {id: secretGroupId}});
    this.activeDeployments.add(project.id);

    // Set initial status
    await this.updateDeploymentStatus(project.id, 'DEPLOYING');

    // Start background task
    this._deployRotationLambdaBackground(project.id).catch(err => {});

    return {
      success: true,
      message: 'Deployment started in background. Please check status shortly.',
    };
  }

  private async _deployRotationLambdaInternal(secretGroupId: string) {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: {id: secretGroupId},
    });

    if (
      !project.awsSecretsManagerAccessKeyId ||
      !project.awsSecretsManagerSecretAccessKey ||
      !project.awsSecretsManagerRegion
    ) {
      throw new BadRequestException(`Project ${project.name} does not have AWS Secrets Manager configured`);
    }

    // Path to infra directory within the microservice
    const infraPath = path.resolve(process.cwd(), 'src/microservices/aws-secrets-manager/infrastructure');

    try {
      // Prepare environment variables
      const env = {
        ...process.env,
        AWS_ACCESS_KEY_ID: project.awsSecretsManagerAccessKeyId,
        AWS_SECRET_ACCESS_KEY: project.awsSecretsManagerSecretAccessKey,
        AWS_REGION: project.awsSecretsManagerRegion,
      };

      const command = `npm install && npx sst deploy --stage ${secretGroupId}`;
      const options = {
        cwd: infraPath,
        env,
        maxBuffer: 10 * 1024 * 1024,
      };

      let stdout = '';
      let stderr = '';

      try {
        const result = await execAsync(command, options);
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (execError: any) {
        // Check for Lock Error
        const errorOutput = execError.stdout?.toString() || '';
        if (errorOutput.includes('Locked') && errorOutput.includes('sst unlock')) {
          // Run Unlock
          await execAsync(`npx sst unlock --stage ${secretGroupId}`, options);

          // Retry Deploy
          const retryResult = await execAsync(command, options);
          stdout = retryResult.stdout;
          stderr = retryResult.stderr;
        } else {
          // Re-throw if not a lock error
          throw execError;
        }
      }

      if (stderr) {
      }

      // Parse Output for Lambda ARN or Name
      // Output format typically: "lambdaArn: arn:aws:lambda..."
      // sst.config.ts returns lambdaArn
      const arnMatch = stdout.match(/lambdaArn:\s+"(arn:aws:lambda:[^"]+)"/);
      // Fallback: check plain format if quotes are missing
      const arnMatchFallback = stdout.match(/lambdaArn:\s+(arn:aws:lambda:[^"\s]+)/);

      const lambdaArn = (arnMatch?.[1] || arnMatchFallback?.[1])?.trim();

      if (!lambdaArn) {
        throw new InternalServerErrorException('Deployment completed but Lambda ARN could not be parsed from output.');
      }

      // Update Project Configuration
      await this.prisma.project.update({
        where: {id: secretGroupId},
        data: {
          awsSecretsManagerRotationLambdaArn: lambdaArn,
        },
      });

      return {
        success: true,
        lambdaArn,
        message: 'Rotation Lambda deployed and Project configuration updated successfully.',
      };
    } catch (error: any) {
      const stderr = error.stderr?.toString() || '';
      const stdout = error.stdout?.toString() || '';

      throw new InternalServerErrorException(
        `Deployment failed. Message: ${error.message}. \nStderr: ${stderr.slice(-1000)} \nStdout: ${stdout.slice(-1000)}`
      );
    }
  }

  /**
   * Remove Rotation Lambda
   */
  async removeRotationLambda(secretGroupId: string) {
    if (this.activeDeployments.has(secretGroupId)) {
      throw new ConflictException('Deployment/Removal already in progress.');
    }

    const project = await this.prisma.project.findUnique({where: {id: secretGroupId}});
    if (!project) throw new NotFoundException(`Project not found: ${secretGroupId}`);

    this.activeDeployments.add(secretGroupId);

    // Set initial status
    await this.updateDeploymentStatus(secretGroupId, 'REMOVING');

    // Start background task
    this._removeRotationLambdaBackground(secretGroupId).catch(err => {});

    return {
      success: true,
      message: 'Removal started in background. Please check status shortly.',
    };
  }

  private async _removeRotationLambdaInternal(secretGroupId: string) {
    const project = await this.prisma.project.findUnique({
      where: {id: secretGroupId},
    });

    if (!project) throw new NotFoundException(`Project not found: ${secretGroupId}`);

    // Path to infra directory within the microservice
    const infraPath = path.resolve(process.cwd(), 'src/microservices/aws-secrets-manager/infrastructure');

    try {
      const env = {
        ...process.env,
        AWS_ACCESS_KEY_ID: project.awsSecretsManagerAccessKeyId || undefined,
        AWS_SECRET_ACCESS_KEY: project.awsSecretsManagerSecretAccessKey || undefined,
        AWS_REGION: project.awsSecretsManagerRegion || undefined,
      };

      const command = `npx sst remove --stage ${secretGroupId}`;
      const options = {cwd: infraPath, env, maxBuffer: 10 * 1024 * 1024};

      try {
        const {stdout} = await execAsync(command, options);
      } catch (execError: any) {
        const errorOutput = execError.stdout?.toString() || '';
        if (errorOutput.includes('Locked') && errorOutput.includes('sst unlock')) {
          await execAsync(`npx sst unlock --stage ${secretGroupId}`, options);
          await execAsync(command, options);
        } else {
          throw execError;
        }
      }

      // Update Project Configuration
      await this.prisma.project.update({
        where: {id: secretGroupId},
        data: {awsSecretsManagerRotationLambdaArn: null},
      });

      return {
        success: true,
        message: 'Rotation Lambda removed and Project configuration updated successfully.',
      };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Removal failed. Message: ${error.message}. \nStderr: ${(error.stderr || '').slice(-1000)}`
      );
    }
  }

  // --- Helper Methods ---

  private async getReadySecretGroup(secretGroupId: string) {
    const secretGroup = await this.prisma.secretGroup.findUniqueOrThrow({
      where: {id: secretGroupId},
    });

    if (!secretGroup.accessKeyId || !secretGroup.secretAccessKey || !secretGroup.rotationLambdaArn) {
      throw new BadRequestException(`Project ${secretGroup.name} does not have AWS Secrets Manager configured`);
    }

    return {
      accessKeyId: secretGroup.accessKeyId,
      secretAccessKey: secretGroup.secretAccessKey,
      rotationLambdaArn: secretGroup.rotationLambdaArn,
    };
  }

  private getClient(config: {accessKeyId: string; secretAccessKey: string}, region?: string): SecretsManagerClient {
    return new SecretsManagerClient({
      region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * Check if secret type supports rotation
   */
  private isRotationSupported(type: SecretType): boolean {
    const supportedTypes: SecretType[] = [
      SecretType.RDS_CREDENTIALS,
      SecretType.DOCUMENTDB_CREDENTIALS,
      SecretType.AWS_API_KEY,
      SecretType.GENERIC_SECRET,
    ];
    return supportedTypes.includes(type);
  }

  // --- Background Task Handlers ---

  private async _deployRotationLambdaBackground(secretGroupId: string) {
    try {
      await this._deployRotationLambdaInternal(secretGroupId);
      await this.updateDeploymentStatus(secretGroupId, 'DEPLOYED', 'Deployment successful');
    } catch (error: any) {
      await this.updateDeploymentStatus(secretGroupId, 'FAILED', error.message);
    } finally {
      this.activeDeployments.delete(secretGroupId);
    }
  }

  private async _removeRotationLambdaBackground(secretGroupId: string) {
    try {
      await this._removeRotationLambdaInternal(secretGroupId);
      await this.updateDeploymentStatus(secretGroupId, 'IDLE', 'Removal successful');
    } catch (error: any) {
      await this.updateDeploymentStatus(secretGroupId, 'FAILED', error.message);
    } finally {
      this.activeDeployments.delete(secretGroupId);
    }
  }

  private async updateDeploymentStatus(secretGroupId: string, status: string, message?: string) {
    try {
      await this.prisma.project.update({
        where: {id: secretGroupId},
        data: {
          awsSecretsManagerDeploymentStatus: status,
          awsSecretsManagerDeploymentMessage: message || null,
        },
      });
    } catch (e) {}
  }
}
