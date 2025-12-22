import {PrismaService} from '@framework/prisma/prisma.service';
import {Body, Controller, Delete, Get, Param, Patch, Post, Query} from '@nestjs/common';
import {ApiTags} from '@nestjs/swagger';
import {Prisma} from '@prisma/client';
import {CreateSecretDto, ListSecretsRequestDto, UpdateSecretDto} from './aws-secrets-manager.dto';

@ApiTags('AWS Secrets Manager')
@Controller('aws-secrets-manager/secrets')
export class AwsSecretsManagerController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('')
  async createSecret(@Body() body: CreateSecretDto) {
    return await this.prisma.secret.create({
      data: body,
    });
  }

  @Get('')
  async listSecrets(@Query() query: ListSecretsRequestDto) {
    return await this.prisma.findManyInManyPages({
      model: Prisma.ModelName.Secret,
      pagination: {page: query.page, pageSize: query.pageSize},
      findManyArgs: {
        orderBy: {createdAt: 'desc'},
      },
    });
  }

  @Get(':id')
  async getSecret(@Param('id') id: string) {
    return await this.prisma.secret.findUnique({
      where: {id},
    });
  }

  @Patch(':id')
  async updateSecret(@Param('id') id: string, @Body() updateSecretDto: UpdateSecretDto) {
    return await this.prisma.secret.update({
      where: {id},
      data: updateSecretDto,
    });
  }

  @Delete(':id')
  async deleteSecret(@Param('id') id: string) {
    return await this.prisma.secret.delete({
      where: {id},
    });
  }

  /* End */
}
