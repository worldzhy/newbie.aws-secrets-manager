import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { IAMClient } from '@aws-sdk/client-iam';

export const smClient = new SecretsManagerClient({});
export const iamClient = new IAMClient({});

export interface RotationEvent {
    Step: 'createSecret' | 'setSecret' | 'testSecret' | 'finishSecret';
    SecretId: string;
    ClientRequestToken: string;
}

export interface RotationStrategy {
    createSecret(secretId: string, token: string, currentDict: any): Promise<void>;
    setSecret(secretId: string, token: string, pendingDict: any, currentDict: any): Promise<void>;
    testSecret(secretId: string, token: string, pendingDict: any): Promise<void>;
    finishSecret(secretId: string, token: string, currentSecret: any): Promise<void>;
}
