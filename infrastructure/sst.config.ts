/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "aws-secrets-manager-rotation",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    // 创建 Secrets Manager 轮询 Lambda 函数
    const rotationFunction = new sst.aws.Function("SecretsManagerRotation", {
      handler: "lambda/rotation-handler.handler",
      runtime: "nodejs20.x",
      timeout: "30 seconds",
      memory: "512 MB",
      environment: {
        NODE_ENV: "production",
      },
      permissions: [
        {
          actions: [
            "secretsmanager:DescribeSecret",
            "secretsmanager:GetSecretValue",
            "secretsmanager:PutSecretValue",
            "secretsmanager:UpdateSecretVersionStage",
            "secretsmanager:GetRandomPassword",
          ],
          resources: ["*"],
        },
      ],
    });

    // 为 Lambda 添加资源策略，允许 Secrets Manager 调用
    new aws.lambda.Permission("SecretsManagerInvokePermission", {
      action: "lambda:InvokeFunction",
      function: rotationFunction.name,
      principal: "secretsmanager.amazonaws.com",
      statementId: "SecretsManagerAccess",
    });

    return {
      lambdaArn: rotationFunction.arn,
      lambdaName: rotationFunction.name,
    };
  },
});
