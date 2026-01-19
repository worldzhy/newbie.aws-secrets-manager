import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {PrismaService} from '@framework/prisma/prisma.service';
import {exec} from 'child_process';
import * as path from 'path';
import {promisify} from 'util';

const execAsync = promisify(exec);
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

@Injectable()
export class AwsSecretsManagerService {
  private readonly logger = new Logger(AwsSecretsManagerService.name);
  private client: SecretsManagerClient;
  private activeDeployments = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService
  ) {
    // Basic init removed, client will be created per request
  }

  /**
   * Create a new Secret
   */
  async createSecret(params: {
    projectId: string;
    name: string;
    type: SecretType;
    secretValue: Record<string, any>;
    description?: string;
    enableRotation?: boolean;
    rotationRules?: {AutomaticallyAfterDays: number};
    awsRegion?: string;
  }) {
    const {projectId, name, type, secretValue, description, enableRotation, rotationRules, awsRegion} = params;

    // Get Project Config
    const projectConfig = await this.getProjectAwsConfig(projectId);
    const client = this.getClient(projectConfig, awsRegion);
    const lambdaArn = enableRotation ? projectConfig.rotationLambdaArn : undefined;

    // Validate rotation prerequisites
    if (enableRotation) {
      if (!this.isRotationSupported(type)) {
        throw new BadRequestException(`Secret type ${type} does not support automatic rotation`);
      }
      if (!lambdaArn) {
        throw new BadRequestException('Lambda ARN is not configured in Project Settings, cannot enable rotation');
      }
    }

    // Check name uniqueness in database
    const existing = await this.prisma.secret.findUnique({where: {name}});
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

    let awsSecretArn: string;
    let awsSecretCreated = false;

    try {
      // Create AWS Secret
      const createCommand = new CreateSecretCommand({
        Name: name,
        Description: description,
        SecretString: JSON.stringify(secretValue),
      });

      const result = await client.send(createCommand);
      awsSecretArn = result.ARN!;
      awsSecretCreated = true;

      this.logger.log(`AWS Secret created: ${name}, ARN: ${awsSecretArn}`);

      // Enable rotation if requested
      if (enableRotation) {
        try {
          await this.enableRotation({
            client,
            secretId: name,
            lambdaArn: lambdaArn!,
            rotationRules: rotationRules || {AutomaticallyAfterDays: 30},
          });
          this.logger.log(`Rotation enabled for Secret: ${name}`);
        } catch (rotationError) {
          // Rollback: Delete the created AWS Secret
          this.logger.error(`Failed to enable rotation: ${rotationError.message}`);
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
          projectId,
          name,
          type,
          awsSecretArn,
          awsRegion: awsRegion || projectConfig.region,
          enableRotation: enableRotation || false,
          rotationLambdaArn: enableRotation ? lambdaArn : null,
          rotationRules: rotationRules ? (rotationRules as any) : null,
          description,
        },
      });

      this.logger.log(`Secret metadata saved to database: ${dbRecord.id}`);
      return dbRecord;
    } catch (error) {
      // If database save fails but AWS Secret was created, rollback is needed
      if (awsSecretCreated && error.code !== 'P2002') {
        // P2002 is Prisma unique constraint violation error
        this.logger.error('Database save failed, rolling back AWS Secret...');
        this.logger.error('Database save failed, rolling back AWS Secret...');
        try {
          await client.send(
            new DeleteSecretCommand({
              SecretId: name,
              ForceDeleteWithoutRecovery: true,
            })
          );
        } catch (rollbackError) {
          this.logger.error(`Rollback failed: ${rollbackError.message}`);
        }
      }
      throw error;
    }
  }

  /**
   * Get complete Secret information (including secret value)
   */
  async getSecretWithValue(secretId: string) {
    const secret = await this.prisma.secret.findUnique({
      where: {id: secretId},
    });

    if (!secret) {
      throw new NotFoundException(`Secret not found: ${secretId}`);
    }

    // Get Project Config
    const projectConfig = await this.getProjectAwsConfig(secret.projectId);
    const client = this.getClient(projectConfig, secret.awsRegion);

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
      this.logger.error(`Failed to get Secret from AWS: ${error.message}`);
      throw new BadRequestException(`Failed to get Secret from AWS Secrets Manager: ${error.message}`);
    }

    return {
      id: secret.id,
      name: secret.name,
      type: secret.type,
      awsSecretArn: secret.awsSecretArn,
      awsRegion: secret.awsRegion,
      description: secret.description,
      enableRotation: secret.enableRotation,
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
    const projectConfig = await this.getProjectAwsConfig(secret.projectId);
    const client = this.getClient(projectConfig, secret.awsRegion);

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
      this.logger.error(`Failed to update AWS Secret: ${error.message}`);
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
      const projectConfig = await this.getProjectAwsConfig(secret.projectId);
      client = this.getClient(projectConfig, secret.awsRegion);
    } catch (e) {
      this.logger.warn(`Could not get project config for deletion: ${e.message}`);
    }

    // Delete AWS Secret
    if (client) {
      try {
        const deleteCommand = new DeleteSecretCommand({
          SecretId: secret.name,
          ForceDeleteWithoutRecovery: forceDelete,
          RecoveryWindowInDays: forceDelete ? undefined : 30,
        });

        await client.send(deleteCommand);
        this.logger.log(`AWS Secret deleted: ${secret.name}`);
      } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
          // AWS Secret does not exist, only delete local record
          this.logger.warn('AWS Secret not found, deleting local record only');
        } else {
          this.logger.error(`Failed to delete AWS Secret: ${error.message}`);
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

    if (!secret.enableRotation) {
      throw new BadRequestException('This Secret does not have automatic rotation enabled');
    }

    // Get Project Config
    const projectConfig = await this.getProjectAwsConfig(secret.projectId);
    const client = this.getClient(projectConfig, secret.awsRegion);

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

      this.logger.log(`Secret rotated successfully: ${secret.name}`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to rotate Secret: ${error.message}`);
      throw new BadRequestException(`Failed to rotate Secret: ${error.message}`);
    }
  }

  /**
   * Enable Rotation (private method)
   */
  private async enableRotation(params: {
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
  async isExistingInAws(name: string, awsRegion?: string): Promise<boolean> {
    // Checking requires client, which requires projectId, but check is usually done before creation
    // We can't check without project config.
    // Refactoring createSecret to do check internally after fetching config.
    // This public method might be problematic if called from outside with just name.
    // For now, removing public access or assuming it's only used inside createSecret which has project context.
    return false; // Placeholder, logic moved inside createSecret
  }

  /**
   * Deploy Rotation Lambda using SST
   */
  async deployRotationLambda(projectId: string) {
    if (this.activeDeployments.has(projectId)) {
      throw new ConflictException('Deployment/Removal already in progress.');
    }

    // Validate project existence before starting background task
    const project = await this.prisma.project.findUnique({where: {id: projectId}});
    if (!project) throw new NotFoundException(`Project not found: ${projectId}`);

    this.activeDeployments.add(projectId);

    // Set initial status
    await this.updateDeploymentStatus(projectId, 'DEPLOYING');

    // Start background task
    this._deployRotationLambdaBackground(projectId).catch(err => {
      this.logger.error(`Background deployment validation failed: ${err.message}`);
    });

    return {
      success: true,
      message: 'Deployment started in background. Please check status shortly.',
    };
  }

  private async _deployRotationLambdaInternal(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: {id: projectId},
    });

    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }

    if (
      !project.awsSecretsManagerAccessKeyId ||
      !project.awsSecretsManagerSecretAccessKey ||
      !project.awsSecretsManagerRegion
    ) {
      throw new BadRequestException(`Project ${project.name} does not have AWS Secrets Manager configured`);
    }

    // Path to infra directory within the microservice
    const infraPath = path.resolve(process.cwd(), 'src/microservices/aws-secrets-manager/infrastructure');
    this.logger.log(`Deploying Rotation Lambda for project ${projectId} from ${infraPath}...`);

    try {
      // Prepare environment variables
      const env = {
        ...process.env,
        AWS_ACCESS_KEY_ID: project.awsSecretsManagerAccessKeyId,
        AWS_SECRET_ACCESS_KEY: project.awsSecretsManagerSecretAccessKey,
        AWS_REGION: project.awsSecretsManagerRegion,
      };

      const command = `npm install && npx sst deploy --stage ${projectId}`;
      const options = {
        cwd: infraPath,
        env,
        maxBuffer: 10 * 1024 * 1024,
      };

      this.logger.log(`Executing command: ${command}`);

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
          this.logger.warn(`SST Lock detected. Executing unlock for stage ${projectId}...`);

          // Run Unlock
          await execAsync(`npx sst unlock --stage ${projectId}`, options);
          this.logger.log(`Stage unlocked. Retrying deployment...`);

          // Retry Deploy
          const retryResult = await execAsync(command, options);
          stdout = retryResult.stdout;
          stderr = retryResult.stderr;
        } else {
          // Re-throw if not a lock error
          throw execError;
        }
      }

      this.logger.log(`SST Deploy Output: ${stdout}`);
      if (stderr) {
        this.logger.warn(`SST Deploy Stderr: ${stderr}`);
      }

      // Parse Output for Lambda ARN or Name
      // Output format typically: "lambdaArn: arn:aws:lambda..."
      // sst.config.ts returns lambdaArn
      const arnMatch = stdout.match(/lambdaArn:\s+"(arn:aws:lambda:[^"]+)"/);
      // Fallback: check plain format if quotes are missing
      const arnMatchFallback = stdout.match(/lambdaArn:\s+(arn:aws:lambda:[^"\s]+)/);

      const lambdaArn = (arnMatch?.[1] || arnMatchFallback?.[1])?.trim();

      if (!lambdaArn) {
        this.logger.error('Could not find Lambda ARN in SST output');
        throw new InternalServerErrorException('Deployment completed but Lambda ARN could not be parsed from output.');
      }

      this.logger.log(`Found Lambda ARN: ${lambdaArn}`);

      // Update Project Configuration
      await this.prisma.project.update({
        where: {id: projectId},
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
      this.logger.error(`Deployment failed details: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
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
  async removeRotationLambda(projectId: string) {
    if (this.activeDeployments.has(projectId)) {
      throw new ConflictException('Deployment/Removal already in progress.');
    }

    const project = await this.prisma.project.findUnique({where: {id: projectId}});
    if (!project) throw new NotFoundException(`Project not found: ${projectId}`);

    this.activeDeployments.add(projectId);

    // Set initial status
    await this.updateDeploymentStatus(projectId, 'REMOVING');

    // Start background task
    this._removeRotationLambdaBackground(projectId).catch(err => {
      this.logger.error(`Background removal failed: ${err.message}`);
    });

    return {
      success: true,
      message: 'Removal started in background. Please check status shortly.',
    };
  }

  private async _removeRotationLambdaInternal(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: {id: projectId},
    });

    if (!project) throw new NotFoundException(`Project not found: ${projectId}`);

    // Path to infra directory within the microservice
    const infraPath = path.resolve(process.cwd(), 'src/microservices/aws-secrets-manager/infrastructure');
    this.logger.log(`Removing Rotation Lambda for project ${projectId}...`);

    try {
      const env = {
        ...process.env,
        AWS_ACCESS_KEY_ID: project.awsSecretsManagerAccessKeyId || undefined,
        AWS_SECRET_ACCESS_KEY: project.awsSecretsManagerSecretAccessKey || undefined,
        AWS_REGION: project.awsSecretsManagerRegion || undefined,
      };

      const command = `npx sst remove --stage ${projectId}`;
      const options = {cwd: infraPath, env, maxBuffer: 10 * 1024 * 1024};

      this.logger.log(`Executing command: ${command}`);

      try {
        const {stdout} = await execAsync(command, options);
        this.logger.log(`SST Remove Output: ${stdout}`);
      } catch (execError: any) {
        const errorOutput = execError.stdout?.toString() || '';
        if (errorOutput.includes('Locked') && errorOutput.includes('sst unlock')) {
          this.logger.warn(`SST Lock detected. Executing unlock...`);
          await execAsync(`npx sst unlock --stage ${projectId}`, options);
          this.logger.log(`Stage unlocked. Retrying removal...`);
          await execAsync(command, options);
        } else {
          throw execError;
        }
      }

      // Update Project Configuration
      await this.prisma.project.update({
        where: {id: projectId},
        data: {awsSecretsManagerRotationLambdaArn: null},
      });

      return {
        success: true,
        message: 'Rotation Lambda removed and Project configuration updated successfully.',
      };
    } catch (error: any) {
      this.logger.error(`Removal failed details: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
      throw new InternalServerErrorException(
        `Removal failed. Message: ${error.message}. \nStderr: ${(error.stderr || '').slice(-1000)}`
      );
    }
  }

  // --- Helper Methods ---

  private async getProjectAwsConfig(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: {id: projectId},
    });

    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }

    if (
      !project.awsSecretsManagerAccessKeyId ||
      !project.awsSecretsManagerSecretAccessKey ||
      !project.awsSecretsManagerRegion
    ) {
      throw new BadRequestException(`Project ${project.name} does not have AWS Secrets Manager configured`);
    }

    return {
      accessKeyId: project.awsSecretsManagerAccessKeyId,
      secretAccessKey: project.awsSecretsManagerSecretAccessKey,
      region: project.awsSecretsManagerRegion,
      rotationLambdaArn: project.awsSecretsManagerRotationLambdaArn,
    };
  }

  private getClient(
    config: {accessKeyId: string; secretAccessKey: string; region: string},
    region?: string
  ): SecretsManagerClient {
    return new SecretsManagerClient({
      region: region || config.region,
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

  private async _deployRotationLambdaBackground(projectId: string) {
    try {
      await this._deployRotationLambdaInternal(projectId);
      await this.updateDeploymentStatus(projectId, 'DEPLOYED', 'Deployment successful');
    } catch (error: any) {
      this.logger.error(`Background deployment failed: ${error.message}`);
      await this.updateDeploymentStatus(projectId, 'FAILED', error.message);
    } finally {
      this.activeDeployments.delete(projectId);
    }
  }

  private async _removeRotationLambdaBackground(projectId: string) {
    try {
      await this._removeRotationLambdaInternal(projectId);
      await this.updateDeploymentStatus(projectId, 'IDLE', 'Removal successful');
    } catch (error: any) {
      this.logger.error(`Background removal failed: ${error.message}`);
      await this.updateDeploymentStatus(projectId, 'FAILED', error.message);
    } finally {
      this.activeDeployments.delete(projectId);
    }
  }

  private async updateDeploymentStatus(projectId: string, status: string, message?: string) {
    try {
      await this.prisma.project.update({
        where: {id: projectId},
        data: {
          awsSecretsManagerDeploymentStatus: status,
          awsSecretsManagerDeploymentMessage: message || null,
        },
      });
    } catch (e) {
      this.logger.error(`Failed to update deployment status: ${e.message}`);
    }
  }
}
