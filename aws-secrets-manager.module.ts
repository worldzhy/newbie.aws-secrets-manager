import {Global, Module} from '@nestjs/common';
import {AwsSecretsManagerController} from './aws-secrets-manager.controller';
import {AwsSecretsManagerService} from './aws-secrets-manager.service';
import {AwsCoreModule} from '@microservices/aws-core/aws-core.module';

@Global()
@Module({
  imports: [AwsCoreModule],
  controllers: [AwsSecretsManagerController],
  providers: [AwsSecretsManagerService],
  exports: [AwsSecretsManagerService],
})
export class AwsSecretsManagerModule {}
