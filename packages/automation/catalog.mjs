import * as z from 'zod/v4';
const collectionId=z.string().regex(/^(inbox|resource):[a-f0-9-]{36}$/);
const key=z.string().min(1).max(1024);
const requestId=z.string().uuid();
export const toolSchemas={
 collections_list:z.object({}).strict(),
 items_list:z.object({collectionId,limit:z.number().int().min(1).max(50).optional(),cursor:z.string().max(4096).optional(),prefix:z.string().max(1024).optional()}).strict(),
 item_read:z.object({collectionId,key}).strict(),
 item_write:z.object({collectionId,key,requestId,dataBase64:z.string().max(87384).optional(),contentType:z.string().max(100).optional(),condition:z.object({absent:z.literal(true).optional(),version:z.string().uuid().optional()}).strict().optional(),actions:z.object({tags:z.array(z.string().max(64)).max(32).optional(),classification:z.enum(['unclassified','personal','work','spam','automation']).optional(),quarantined:z.boolean().optional(),read:z.boolean().optional()}).strict().optional()}).strict(),
 item_delete:z.object({collectionId,key,requestId,version:z.string().uuid().optional()}).strict()
};

export const TOOLS=[{name:'collections_list',label:'See selected collection names',readOnly:true,destructive:false},{name:'items_list',label:'List items',readOnly:true,destructive:false},{name:'item_read',label:'Read item contents',readOnly:true,destructive:false},{name:'item_write',label:'Create files or edit message metadata',readOnly:false,destructive:false},{name:'item_delete',label:'Delete items',readOnly:false,destructive:true}];
export function toolCatalog(){return TOOLS.map(t=>({...t,inputSchema:z.toJSONSchema(toolSchemas[t.name])}));}
export function validateTool(name,args){const schema=Object.hasOwn(toolSchemas,name)?toolSchemas[name]:null;if(!schema)throw Object.assign(new Error('Unknown tool.'),{code:'unsupported_method',status:400});const parsed=schema.safeParse(args);if(!parsed.success)throw Object.assign(new Error('Invalid tool arguments.'),{code:'invalid_args',status:400});return parsed.data;}

export function boundedToolResult(result){if(new TextEncoder().encode(JSON.stringify(result)).length>100000)throw Object.assign(new Error('The result exceeds this endpoint limit.'),{code:'result_too_large',status:413});return result;}
