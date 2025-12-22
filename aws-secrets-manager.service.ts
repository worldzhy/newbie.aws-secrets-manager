import {Injectable} from '@nestjs/common';
import {PrismaService} from '@framework/prisma/prisma.service';
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
  UpdateSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import {ConfigService} from '@nestjs/config';

@Injectable()
export class AwsSecretsManagerService {
  private client;
  constructor(private readonly config: ConfigService) {
    const accessKeyId = this.config.get<string>('microservices.aws-secrets-manager.accessKeyId');
    const secretAccessKey = this.config.get<string>('microservices.aws-secrets-manager.secretAccessKey');
    const region = this.config.get<string>('microservices.aws-secrets-manager.region');

    this.client = new SecretsManagerClient({
      region,
      credentials: accessKeyId && secretAccessKey ? {accessKeyId, secretAccessKey} : undefined,
    });
  }

  async create(params: {name: string; kvPairs: object; description: string}) {
    const command = new CreateSecretCommand({
      Name: params.name,
      Description: params.description,
      SecretString: JSON.stringify(params.kvPairs, null, 2),
    });

    return await this.client.send(command);
  }

  async get(name: string) {
    try {
      const command = new GetSecretValueCommand({SecretId: name});
      const response = await this.client.send(command);

      if (response.SecretString) {
        return JSON.parse(response.SecretString);
      } else if (response.SecretBinary) {
        const buff = Buffer.from(response.SecretBinary, 'base64');
        return JSON.parse(buff.toString('ascii'));
      } else {
        return {};
      }
    } catch (error) {
      return null;
    }
  }

  async update(params: {name: string; kvPairs: object}) {
    const command = new UpdateSecretCommand({
      SecretId: params.name,
      SecretString: JSON.stringify(params.kvPairs, null, 2),
    });

    return await this.client.send(command);
  }

  async isExisting(name: string) {
    try {
      await this.client.send(new DescribeSecretCommand({SecretId: name}));
      return true;
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') {
        return false;
      }
      throw error;
    }
  }
}
