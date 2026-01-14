import {ApiProperty} from '@nestjs/swagger';
import {IsString, IsOptional, IsEnum} from 'class-validator';
import {CommonListRequestDto, CommonListResponseDto} from '@framework/common.dto';
import {SecretType} from '@generated/prisma/client';

export class ListSecretsRequestDto extends CommonListRequestDto {}

export class ListSecretsResponseDto extends CommonListResponseDto {}

export class CreateSecretDto {
  @ApiProperty({type: String, required: true})
  @IsString()
  name: string;

  @ApiProperty({type: String, enum: SecretType, required: true})
  @IsEnum(SecretType)
  type: SecretType;

  @ApiProperty({type: String, required: false})
  @IsOptional()
  @IsString()
  updateInterval?: string;
}

export class UpdateSecretDto {
  @ApiProperty({type: String, required: false})
  @IsOptional()
  @IsString()
  updateInterval?: string;
}
