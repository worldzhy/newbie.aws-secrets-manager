import {PrismaService} from '@framework/prisma/prisma.service';
import {Body, Controller, Delete, Get, Param, Patch, Post, Query} from '@nestjs/common';
import {ApiTags, ApiOperation, ApiResponse, ApiBearerAuth} from '@nestjs/swagger';
import {Prisma} from '@generated/prisma/client';
import {
  CreateSecretDto,
  ListSecretsRequestDto,
  UpdateSecretDto,
  GetSecretValueResponseDto,
  DeployRotationLambdaDto,
} from './aws-secrets-manager.dto';
import {AwsSecretsManagerService} from './aws-secrets-manager.service';

@ApiTags('AWS Secrets Manager')
@ApiBearerAuth()
@Controller('aws-secrets-manager/secrets')
export class AwsSecretsManagerController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secretsService: AwsSecretsManagerService
  ) {}

  @Post('')
  @ApiOperation({summary: 'Create Secret'})
  @ApiResponse({status: 201, description: 'Secret created successfully'})
  async createSecret(@Body() body: CreateSecretDto) {
    return await this.secretsService.createSecret({
      name: body.name,
      type: body.type,
      region: body.region,
      secretValue: body.secretValue,
      rotationEnabled: body.rotationEnabled,
      rotationRules: body.rotationRules,
      description: body.description,
      secretGroupId: body.secretGroupId,
    });
  }

  @Get('')
  @ApiOperation({summary: 'List all Secrets (metadata only, no secret values)'})
  async listSecrets(@Query() query: ListSecretsRequestDto) {
    return await this.prisma.findManyInManyPages({
      model: Prisma.ModelName.Secret,
      pagination: {page: query.page, pageSize: query.pageSize},
      findManyArgs: {orderBy: {createdAt: 'desc'}},
    });
  }

  @Get(':id')
  @ApiOperation({summary: 'Get Secret metadata (no secret value)'})
  async getSecret(@Param('id') id: string) {
    return await this.prisma.secret.findUniqueOrThrow({where: {id}});
  }

  @Get(':id/value')
  @ApiOperation({summary: 'Get complete Secret information (including secret value)'})
  @ApiResponse({type: GetSecretValueResponseDto, description: 'Complete Secret information (including secret value)'})
  async getSecretValue(@Param('id') id: string): Promise<GetSecretValueResponseDto> {
    // This endpoint is called when user clicks "View Password" in UI
    return await this.secretsService.getSecretWithValue(id);
  }

  @Patch(':id')
  @ApiOperation({summary: 'Update Secret'})
  async updateSecret(@Param('id') id: string, @Body() body: UpdateSecretDto) {
    return await this.secretsService.updateSecret(id, {
      secretValue: body.secretValue,
      description: body.description,
    });
  }

  @Delete(':id')
  @ApiOperation({summary: 'Delete Secret'})
  async deleteSecret(@Param('id') id: string) {
    return await this.secretsService.deleteSecret(id);
  }

  @Post(':id/rotate')
  @ApiOperation({summary: 'Manually trigger Secret rotation'})
  @ApiResponse({status: 200, description: 'Rotation triggered successfully'})
  async rotateSecret(@Param('id') id: string) {
    return await this.secretsService.rotateSecret(id);
  }

  @Post('deploy-rotation-lambda')
  @ApiOperation({summary: 'Deploy Rotation Lambda via SST'})
  @ApiResponse({status: 200, description: 'Lambda deployed successfully'})
  async deployRotationLambda(@Body() body: DeployRotationLambdaDto) {
    return await this.secretsService.deployRotationLambda(body.projectId);
  }

  @Post('remove-rotation-lambda')
  @ApiOperation({summary: 'Remove Rotation Lambda via SST'})
  @ApiResponse({status: 200, description: 'Lambda removed successfully'})
  async removeRotationLambda(@Body() body: DeployRotationLambdaDto) {
    return await this.secretsService.removeRotationLambda(body.projectId);
  }

  /* End */
}
