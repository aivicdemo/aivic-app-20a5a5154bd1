import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Role, User, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface ResourceItem {
  pk: string;
  sk: string;
  id: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: any;
}

const TABLE_CONFIGS = {
  '0': { name: 'users', pk: 'USER' },
  '1': { name: 'files', pk: 'FILE' },
  '2': { name: 'translations', pk: 'TRANSLATION' },
  '3': { name: 'formats', pk: 'FORMAT' },
  '4': { name: 'engines', pk: 'ENGINE' },
  '5': { name: 'history', pk: 'HISTORY' },
  '6': { name: 'errors', pk: 'ERROR' },
  '7': { name: 'settings', pk: 'SETTING' },
  '8': { name: 'evaluations', pk: 'EVALUATION' }
};

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('No authorization header');
  }
  
  // Mock user extraction - in real implementation, decode JWT token
  const role = (event.headers['x-user-role'] as Role) || 'viewer';
  const userId = event.headers['x-user-id'] || 'anonymous';
  
  return {
    id: userId,
    role,
    permissions: []
  };
}

function createResponse(statusCode: number, body: any, isNotebook: boolean = false): APIGatewayProxyResult {
  const baseResponse = {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'
    },
    body: JSON.stringify(body)
  };

  if (isNotebook) {
    return {
      ...baseResponse,
      body: JSON.stringify({
        ...body,
        ui: {
          theme: 'notebook',
          style: {
            background: '#f9f7f4',
            border: '1px solid #d4c5a9',
            fontFamily: 'Georgia, serif',
            boxShadow: '2px 2px 8px rgba(0,0,0,0.1)',
            margin: '10px',
            padding: '20px',
            borderRadius: '3px'
          },
          elements: {
            paper: 'lined',
            binding: 'spiral',
            texture: 'aged'
          }
        }
      })
    };
  }

  return baseResponse;
}

async function writeAuditLog(action: string, userId: string, details: any): Promise<void> {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    id: randomUUID(),
    action,
    userId,
    details,
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = getCurrentUser(event);
    const method = event.httpMethod;
    const path = event.path;
    const pathSegments = path.split('/').filter(Boolean);

    // Handle GET /resources
    if (method === 'GET' && path === '/resources') {
      checkPermission(user, 'files:read');
      
      const command = new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'FILE'
        }
      });
      
      const result = await docClient.send(command);
      return createResponse(200, {
        resources: result.Items || [],
        count: result.Count || 0
      }, true);
    }

    // Handle bulk import endpoints
    if (method === 'POST' && pathSegments.length === 3 && pathSegments[0] === 'api' && pathSegments[2] === 'bulk') {
      const tableIndex = pathSegments[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!tableConfig) {
        return createResponse(404, { error: 'Table not found' });
      }

      checkPermission(user, 'bulk:import');
      
      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      
      // Process in batches of 25 (DynamoDB BatchWrite limit)
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map(item => {
          const now = new Date().toISOString();
          const id = item.id || randomUUID();
          
          return {
            PutRequest: {
              Item: {
                ...item,
                pk: tableConfig.pk,
                sk: id,
                id,
                createdAt: item.createdAt || now,
                updatedAt: now
              }
            }
          };
        });

        try {
          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: writeRequests
            }
          }));
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      await writeAuditLog('BULK_IMPORT', user.id, {
        table: tableConfig.name,
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, {
        imported,
        failed,
        errors
      }, true);
    }

    // Handle CRUD operations for specific tables
    if (pathSegments.length >= 2 && pathSegments[0] === 'api') {
      const tableIndex = pathSegments[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!tableConfig) {
        return createResponse(404, { error: 'Table not found' });
      }

      const resourceName = tableConfig.name;
      const pk = tableConfig.pk;

      // GET /api/{tableIndex} - List all items
      if (method === 'GET' && pathSegments.length === 2) {
        checkPermission(user, `${resourceName}:read`);
        
        const command = new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': pk
          }
        });
        
        const result = await docClient.send(command);
        return createResponse(200, {
          items: result.Items || [],
          count: result.Count || 0
        }, true);
      }

      // GET /api/{tableIndex}/{id} - Get specific item
      if (method === 'GET' && pathSegments.length === 3) {
        checkPermission(user, `${resourceName}:read`);
        
        const id = pathSegments[2];
        const command = new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: pk,
            sk: id
          }
        });
        
        const result = await docClient.send(command);
        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        return createResponse(200, result.Item, true);
      }

      // POST /api/{tableIndex} - Create new item
      if (method === 'POST' && pathSegments.length === 2) {
        checkPermission(user, `${resourceName}:write`);
        
        const body = JSON.parse(event.body || '{}');
        const now = new Date().toISOString();
        const id = randomUUID();
        
        const item: ResourceItem = {
          ...body,
          pk: pk,
          sk: id,
          id,
          createdAt: now,
          updatedAt: now
        };
        
        const command = new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        });
        
        await docClient.send(command);
        await writeAuditLog('CREATE', user.id, { table: resourceName, itemId: id });
        
        return createResponse(201, item, true);
      }

      // PUT /api/{tableIndex}/{id} - Update item
      if (method === 'PUT' && pathSegments.length === 3) {
        checkPermission(user, `${resourceName}:write`);
        
        const id = pathSegments[2];
        const body = JSON.parse(event.body || '{}');
        
        // Check if item exists
        const getCommand = new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: pk,
            sk: id
          }
        });
        
        const existingItem = await docClient.send(getCommand);
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        const updatedItem = {
          ...existingItem.Item,
          ...body,
          pk: pk,
          sk: id,
          id,
          updatedAt: new Date().toISOString()
        };
        
        const putCommand = new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        });
        
        await docClient.send(putCommand);
        await writeAuditLog('UPDATE', user.id, { table: resourceName, itemId: id });
        
        return createResponse(200, updatedItem, true);
      }

      // DELETE /api/{tableIndex}/{id} - Delete item
      if (method === 'DELETE' && pathSegments.length === 3) {
        checkPermission(user, `${resourceName}:delete`);
        
        const id = pathSegments[2];
        
        // Check if item exists
        const getCommand = new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: pk,
            sk: id
          }
        });
        
        const existingItem = await docClient.send(getCommand);
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        const deleteCommand = new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: pk,
            sk: id
          }
        });
        
        await docClient.send(deleteCommand);
        await writeAuditLog('DELETE', user.id, { table: resourceName, itemId: id });
        
        return createResponse(200, { message: 'Item deleted successfully' }, true);
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Insufficient permissions')) {
        return createResponse(403, { error: 'Forbidden: ' + error.message });
      }
      if (error.message.includes('No authorization header')) {
        return createResponse(401, { error: 'Unauthorized' });
      }
      if (error.message.includes('not found')) {
        return createResponse(404, { error: error.message });
      }
    }
    
    return createResponse(500, { 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};