import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { getUserFromEvent, checkPermission, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers: { [key: string]: string };
}

interface APIResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

const TABLE_CONFIGS = {
  '0': { name: 'users', pk: 'USER' },
  '1': { name: 'files', pk: 'FILE' },
  '2': { name: 'translation_progress', pk: 'PROGRESS' },
  '3': { name: 'file_formats', pk: 'FORMAT' },
  '4': { name: 'translation_engines', pk: 'ENGINE' },
  '5': { name: 'translation_history', pk: 'HISTORY' },
  '6': { name: 'error_logs', pk: 'ERROR' },
  '7': { name: 'system_settings', pk: 'SETTING' },
  '8': { name: 'quality_evaluations', pk: 'EVALUATION' }
};

async function createAuditLog(user: User, action: string, resourceType: string, resourceId?: string, details?: any): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resourceType,
    resourceId,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateRequired(data: any, fields: string[]): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    if (!data[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function createResponse(statusCode: number, body: any): APIResponse {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body)
  };
}

function createErrorResponse(statusCode: number, message: string): APIResponse {
  return createResponse(statusCode, { error: message });
}

async function handleGetResources(event: APIGatewayEvent, user: User): Promise<APIResponse> {
  try {
    checkPermission(user, 'resources:read');
    
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk <> :auditPk',
      ExpressionAttributeValues: {
        ':auditPk': 'AUDIT'
      }
    }));
    
    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createErrorResponse(403, error.message);
    }
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleBulkImport(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIResponse> {
  try {
    checkPermission(user, 'bulk:write');
    
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    if (!tableConfig) {
      return createErrorResponse(404, 'Table not found');
    }
    
    const body = JSON.parse(event.body || '{}');
    if (!body.items || !Array.isArray(body.items)) {
      return createErrorResponse(400, 'Invalid request body. Expected { items: [] }');
    }
    
    const items = body.items;
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    
    // Process in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const putRequests = batch.map(item => {
        const now = new Date().toISOString();
        const processedItem = {
          ...item,
          pk: tableConfig.pk,
          sk: item.id || randomUUID(),
          id: item.id || randomUUID(),
          createdAt: item.createdAt || now,
          updatedAt: now
        };
        
        return {
          PutRequest: {
            Item: processedItem
          }
        };
      });
      
      try {
        await docClient.send(new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: putRequests
          }
        }));
        imported += batch.length;
      } catch (error: any) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i/25) + 1}: ${error.message}`);
      }
    }
    
    await createAuditLog(user, 'BULK_IMPORT', tableConfig.name, undefined, {
      imported,
      failed,
      totalItems: items.length
    });
    
    return createResponse(200, {
      imported,
      failed,
      errors
    });
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createErrorResponse(403, error.message);
    }
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetResourceById(event: APIGatewayEvent, user: User): Promise<APIResponse> {
  try {
    checkPermission(user, 'resources:read');
    
    const id = event.pathParameters?.id;
    if (!id) {
      return createErrorResponse(400, 'ID parameter is required');
    }
    
    // Try to find the resource by scanning for the ID
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'id = :id AND pk <> :auditPk',
      ExpressionAttributeValues: {
        ':id': id,
        ':auditPk': 'AUDIT'
      }
    }));
    
    if (!result.Items || result.Items.length === 0) {
      return createErrorResponse(404, 'Resource not found');
    }
    
    return createResponse(200, result.Items[0]);
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createErrorResponse(403, error.message);
    }
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleCreateResource(event: APIGatewayEvent, user: User): Promise<APIResponse> {
  try {
    checkPermission(user, 'resources:write');
    
    const body = JSON.parse(event.body || '{}');
    const resourceType = body.resourceType || 'RESOURCE';
    
    // Basic validation
    if (!body.name && !body.fileName && !body.engineName && !body.settingKey) {
      return createErrorResponse(400, 'At least one identifying field is required');
    }
    
    const now = new Date().toISOString();
    const id = randomUUID();
    
    const item = {
      ...body,
      pk: resourceType,
      sk: id,
      id,
      createdAt: now,
      updatedAt: now,
      createdBy: user.id
    };
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));
    
    await createAuditLog(user, 'CREATE', resourceType, id, item);
    
    return createResponse(201, item);
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createErrorResponse(403, error.message);
    }
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleUpdateResource(event: APIGatewayEvent, user: User): Promise<APIResponse> {
  try {
    checkPermission(user, 'resources:write');
    
    const id = event.pathParameters?.id;
    if (!id) {
      return createErrorResponse(400, 'ID parameter is required');
    }
    
    const body = JSON.parse(event.body || '{}');
    
    // Find existing resource
    const existingResult = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'id = :id AND pk <> :auditPk',
      ExpressionAttributeValues: {
        ':id': id,
        ':auditPk': 'AUDIT'
      }
    }));
    
    if (!existingResult.Items || existingResult.Items.length === 0) {
      return createErrorResponse(404, 'Resource not found');
    }
    
    const existing = existingResult.Items[0];
    const now = new Date().toISOString();
    
    const updatedItem = {
      ...existing,
      ...body,
      id: existing.id,
      pk: existing.pk,
      sk: existing.sk,
      createdAt: existing.createdAt,
      updatedAt: now,
      updatedBy: user.id
    };
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));
    
    await createAuditLog(user, 'UPDATE', existing.pk, id, { before: existing, after: updatedItem });
    
    return createResponse(200, updatedItem);
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createErrorResponse(403, error.message);
    }
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleDeleteResource(event: APIGatewayEvent, user: User): Promise<APIResponse> {
  try {
    checkPermission(user, 'resources:write');
    
    const id = event.pathParameters?.id;
    if (!id) {
      return createErrorResponse(400, 'ID parameter is required');
    }
    
    // Find existing resource
    const existingResult = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'id = :id AND pk <> :auditPk',
      ExpressionAttributeValues: {
        ':id': id,
        ':auditPk': 'AUDIT'
      }
    }));
    
    if (!existingResult.Items || existingResult.Items.length === 0) {
      return createErrorResponse(404, 'Resource not found');
    }
    
    const existing = existingResult.Items[0];
    
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: existing.pk,
        sk: existing.sk
      }
    }));
    
    await createAuditLog(user, 'DELETE', existing.pk, id, existing);
    
    return createResponse(200, { message: 'Resource deleted successfully' });
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createErrorResponse(403, error.message);
    }
    return createErrorResponse(500, 'Internal server error');
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }
  
  try {
    const user = getUserFromEvent(event);
    const path = event.path;
    const method = event.httpMethod;
    
    // Handle bulk import endpoints
    const bulkMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (bulkMatch && method === 'POST') {
      return await handleBulkImport(event, user, bulkMatch[1]);
    }
    
    // Handle main resource endpoints
    if (path === '/resources') {
      switch (method) {
        case 'GET':
          return await handleGetResources(event, user);
        case 'POST':
          return await handleCreateResource(event, user);
        default:
          return createErrorResponse(405, 'Method not allowed');
      }
    }
    
    // Handle resource by ID endpoints
    const resourceMatch = path.match(/^\/resources\/([^/]+)$/);
    if (resourceMatch) {
      switch (method) {
        case 'GET':
          return await handleGetResourceById(event, user);
        case 'PUT':
          return await handleUpdateResource(event, user);
        case 'DELETE':
          return await handleDeleteResource(event, user);
        default:
          return createErrorResponse(405, 'Method not allowed');
      }
    }
    
    return createErrorResponse(404, 'Endpoint not found');
  } catch (error: any) {
    if (error.message.includes('No authorization header') || error.message.includes('Invalid token')) {
      return createErrorResponse(401, 'Unauthorized');
    }
    return createErrorResponse(500, 'Internal server error');
  }
};