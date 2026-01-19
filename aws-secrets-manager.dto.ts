import {ApiProperty} from '@nestjs/swagger';
import {IsString, IsOptional, IsEnum, IsBoolean, IsObject, ValidateIf} from 'class-validator';
import {CommonListRequestDto, CommonListResponseDto} from '@framework/common.dto';
import {SecretType} from '@generated/prisma/client';

export class ListSecretsRequestDto extends CommonListRequestDto {
  @ApiProperty({description: 'Project ID for filtering', required: true})
  @IsString()
  projectId: string;
}

export class ListSecretsResponseDto extends CommonListResponseDto {}

export class CreateSecretDto {
  @ApiProperty({description: 'Secret name (unique identifier)', required: true})
  @IsString()
  name: string;

  @ApiProperty({description: 'Secret description', required: false})
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({enum: SecretType, description: 'Secret type', required: true})
  @IsEnum(SecretType)
  type: SecretType;

  @ApiProperty({description: 'Secret value (key-value pairs)', type: Object, required: true})
  @IsObject()
  secretValue: Record<string, any>;

  @ApiProperty({description: 'AWS Region (defaults to region in configuration)', required: false})
  @IsOptional()
  @IsString()
  region?: string;

  @ApiProperty({
    description: 'Enable automatic rotation (only for RDS_CREDENTIALS/DOCUMENTDB_CREDENTIALS/AWS_API_KEY)',
    default: false,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  rotationEnabled?: boolean;

  @ApiProperty({
    description: 'Rotation rules configuration',
    type: Object,
    required: false,
    example: {AutomaticallyAfterDays: 30},
  })
  @IsOptional()
  @IsObject()
  @ValidateIf(o => o.enableRotation === true)
  rotationRules?: {AutomaticallyAfterDays: number};

  @ApiProperty({description: 'Group ID', required: true})
  @IsString()
  secretGroupId: string;
}

export class UpdateSecretDto {
  @ApiProperty({description: 'Update Secret value', type: Object, required: false})
  @IsOptional()
  @IsObject()
  secretValue?: Record<string, any>;

  @ApiProperty({description: 'Update description', required: false})
  @IsOptional()
  @IsString()
  description?: string;
}

export class GetSecretValueResponseDto {
  @ApiProperty({description: 'Secret ID'})
  id: string;

  @ApiProperty({description: 'Secret name'})
  name: string;

  @ApiProperty({enum: SecretType, description: 'Secret type'})
  type: SecretType;

  @ApiProperty({description: 'Actual secret value', type: Object})
  secretValue: Record<string, any>;

  @ApiProperty({description: 'Description', required: false})
  description?: string | null;

  @ApiProperty({description: 'AWS Secret ARN'})
  arn: string;

  @ApiProperty({description: 'AWS Region'})
  region: string;

  @ApiProperty({description: 'Enable automatic rotation'})
  rotationEnabled: boolean;

  @ApiProperty({description: 'Lambda ARN', required: false})
  rotationLambdaArn?: string | null;

  @ApiProperty({description: 'Rotation rules', required: false})
  rotationRules?: any;

  @ApiProperty({description: 'Last rotation timestamp', required: false})
  lastRotatedAt?: Date | null;

  @ApiProperty({description: 'Created at'})
  createdAt: Date;

  @ApiProperty({description: 'Updated at'})
  updatedAt: Date;
}

export class DeployRotationLambdaDto {
  @ApiProperty({description: 'Project ID where to deploy Lambda', required: true})
  @IsString()
  projectId: string;
}
