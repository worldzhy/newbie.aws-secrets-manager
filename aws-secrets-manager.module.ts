import {Global, Module} from '@nestjs/common';
import {AwsSecretsManagerController} from './aws-secrets-manager.controller';
import {AwsSecretsManagerService} from './aws-secrets-manager.service';

@Global()
@Module({
  controllers: [AwsSecretsManagerController],
  providers: [AwsSecretsManagerService],
  exports: [AwsSecretsManagerService],
})
export class AwsSecretsManagerModule {}
