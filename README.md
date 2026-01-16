# AWS Secrets Manager Microservice

A microservice for managing sensitive information and credentials, supporting dual storage modes (local encrypted storage and AWS Secrets Manager) with automatic password rotation.

## Features

### Dual Storage Modes
- **LOCAL Mode**: AES-256-CBC encrypted storage in local database (suitable for development/testing environments)
- **AWS Mode**: Store in AWS Secrets Manager, local database only keeps metadata (recommended for production)

### Automatic Password Rotation
Supports automatic password rotation for the following services:
- RDS databases (MySQL, PostgreSQL, etc.)
- DocumentDB (MongoDB compatible)
- AWS API keys (for SNS, SES, S3, etc.)

### Security Features
- AES-256-CBC encryption algorithm (LOCAL mode)
- On-demand password retrieval (AWS mode only fetches from AWS when viewing)
- Always fetches latest version (AWSCURRENT)
- Complete error handling and rollback mechanism

## Configuration
    
### Project Configuration
    
AWS Secrets Manager integration is configured on a **Per-Project** basis. 
    
Please navigate to the **Project Settings** page in the UI to configure:
- AWS Access Key ID
- AWS Secret Access Key
- AWS Region
- Rotation Lambda ARN (optional, for rotation support)

## API Endpoints

### Create Secret

```http
POST /aws-secrets-manager/secrets
Content-Type: application/json

{
  "name": "my-database-credentials",
  "type": "RDS_CREDENTIALS",
  "storageType": "AWS",
  "secretValue": {
    "username": "admin",
    "password": "MyPassword123!",
    "host": "mydb.us-east-1.rds.amazonaws.com",
    "port": 3306,
    "dbname": "production"
  },
  "enableRotation": true,
  "rotationRules": {
    "AutomaticallyAfterDays": 30
  },
  "description": "Production database credentials"
}
```

### List All Secrets

```http
GET /aws-secrets-manager/secrets?page=0&pageSize=10
```

Returns metadata list (no secret values).

### Get Secret Metadata

```http
GET /aws-secrets-manager/secrets/:id
```

Returns Secret metadata (no secret value).

### Get Complete Secret Information (with password)

```http
GET /aws-secrets-manager/secrets/:id/value
```

Returns complete information including secret value. Used for "View Password" functionality in UI.

### Update Secret

```http
PATCH /aws-secrets-manager/secrets/:id
Content-Type: application/json

{
  "secretValue": {
    "username": "admin",
    "password": "NewPassword456!"
  },
  "description": "Updated description"
}
```

### Delete Secret

```http
DELETE /aws-secrets-manager/secrets/:id
```

Soft delete (30-day recovery period) by default in AWS mode.

### Manually Trigger Rotation

```http
POST /aws-secrets-manager/secrets/:id/rotate
```

Only applicable to AWS Secrets with automatic rotation enabled.

## Secret Types

- `RDS_CREDENTIALS`: RDS database credentials (supports rotation)
- `DOCUMENTDB_CREDENTIALS`: DocumentDB credentials (supports rotation)
- `AWS_API_KEY`: AWS API keys for SNS/SES/S3, etc. (supports rotation)
- `GENERIC_SECRET`: Generic secret (no rotation support)

## Lambda Function Deployment

To enable automatic rotation functionality, deploy a Lambda function. This microservice provides complete SST deployment scripts.

### Quick Deployment

```bash
# Navigate to deployment directory (from project root)
cd ../../../infra

# Install dependencies
npm install

# Deploy to development environment
npm run deploy:dev

# Or deploy to production
npm run deploy
```

After deployment, copy the output Lambda ARN to **Project Settings** in the UI.

### Lambda Rotation Process

Lambda function implements 4 steps:

1. **createSecret**: Generate new password version, create AWSPENDING tag
2. **setSecret**: Set new password in target service (RDS/DocumentDB)
3. **testSecret**: Test if new password is valid
4. **finishSecret**: Move AWSCURRENT tag to new version

### Production Environment Configuration

Current Lambda function is a mock implementation. For production:

1. **Configure VPC**: Lambda needs to be deployed in the same VPC as RDS/DocumentDB
2. **Add database clients**: Install `mysql2`, `pg` or `mongodb` dependencies
3. **Enable real logic**: Uncomment code in `rotation-handler-mysql.example.ts`

For details, refer to: [../../../infra/README.md](../../../infra/README.md)

### Lambda IAM Permissions

Deployment script automatically configures the following permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecretVersionStage",
        "secretsmanager:GetRandomPassword"
      ],
      "Resource": "*"
    }
  ]
}
```

It also automatically adds resource policy to allow Secrets Manager to invoke Lambda:

```json
{
  "Principal": "secretsmanager.amazonaws.com",
  "Action": "lambda:InvokeFunction"
}
```

## Usage Examples

### Create Local Test Secret

```typescript
// LOCAL mode - suitable for development environment
const localSecret = await fetch('/aws-secrets-manager/secrets', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    name: 'local-api-key',
    type: 'GENERIC_SECRET',
    storageType: 'LOCAL',
    secretValue: {
      apiKey: 'test-key-12345',
      apiSecret: 'test-secret-67890'
    },
    description: 'Local test API key'
  })
});
```

### Create AWS Secret with Rotation Enabled

```typescript
// AWS mode + automatic rotation - suitable for production
const prodSecret = await fetch('/aws-secrets-manager/secrets', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    name: 'prod-rds-mysql',
    type: 'RDS_CREDENTIALS',
    storageType: 'AWS',
    secretValue: {
      username: 'admin',
      password: 'InitialPassword123!',
      host: 'mydb.us-east-1.rds.amazonaws.com',
      port: 3306,
      dbname: 'production'
    },
    enableRotation: true,
    rotationRules: {
      AutomaticallyAfterDays: 30
    },
    description: 'Production RDS MySQL credentials',
    tags: {
      Environment: 'Production',
      Service: 'MySQL'
    }
  })
});
```

### Get Secret Value

```typescript
// Get complete Secret information (including password)
const secretWithValue = await fetch('/aws-secrets-manager/secrets/{id}/value')
  .then(res => res.json());

console.log(secretWithValue.secretValue); // Actual secret value
```

## Database Migration

Run database migration before first use:

```bash
npx prisma migrate dev --name add_aws_secrets_manager_rotation_support
```

## Important Notes

### Production Environment

1. **Encryption Key Management**:
   - Production encryption keys should be stored in AWS Secrets Manager or AWS Parameter Store
   - Do not commit keys to code repository

2. **IAM Permission Minimization**:
   - AWS credentials should only grant necessary Secrets Manager permissions
   - Lambda function should only grant rotation-required permissions

3. **API Security**:
   - All API endpoints should add authentication and authorization
   - `/secrets/:id/value` endpoint should record audit logs

### Performance Considerations

1. **AWS API Limitations**:
   - AWS Secrets Manager has API rate limits (1000 TPS)
   - Consider adding caching layer for high-frequency query scenarios

2. **Database Indexing**:
   - `name` field has unique index to ensure query performance

## Dependencies

- `@aws-sdk/client-secrets-manager`: ^3.929.0
