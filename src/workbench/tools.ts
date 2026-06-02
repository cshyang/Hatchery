import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { D1Like } from '../skills/repository';
import {
  MODEL_WORK_ITEM_STATUSES,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItemStatus,
  type ClockAndIds,
} from './repository';

export function workbenchTools(db: D1Like, projectId: string, deps: ClockAndIds = {}): ToolDefinition[] {
  const create = defineTool({
    name: 'create_work_item',
    description:
      'Record a durable project work item or child task in the Hatchery workbench. Use this for todo items, decomposition, and task tracking.',
    parameters: Type.Object({
      title: Type.String({ description: 'Short task title.' }),
      body: Type.Optional(Type.String({ description: 'Optional task detail, acceptance notes, or current context.' })),
      parentId: Type.Optional(Type.String({ description: 'Optional parent work item id in this same project.' })),
      priority: Type.Optional(Type.Number({ description: 'Optional priority; higher numbers sort earlier in future UI.' })),
    }),
    async execute({ title, body, parentId, priority }) {
      const { item } = await createWorkItem(
        db,
        {
          projectId,
          title: String(title),
          body: body == null ? null : String(body),
          parentId: parentId == null ? null : String(parentId),
          priority: priority == null ? 0 : Number(priority),
          sourceType: 'manual',
          updatedByType: 'model',
          updatedById: 'agent',
        },
        deps,
      );
      return JSON.stringify(item, null, 2);
    },
  });

  const list = defineTool({
    name: 'list_work_items',
    description: 'List durable project work items from the Hatchery workbench, optionally filtered by status.',
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: 'Optional status filter, e.g. requested, running, blocked, completed.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum rows to return; defaults to 25.' })),
    }),
    async execute({ status, limit }) {
      const items = await listWorkItems(db, projectId, {
        status: status == null ? null : String(status),
        limit: limit == null ? null : Number(limit),
      });
      return JSON.stringify(items, null, 2);
    },
  });

  const get = defineTool({
    name: 'get_work_item',
    description: 'Read one durable project work item by id before acting on it or updating its progress.',
    parameters: Type.Object({ id: Type.String({ description: 'Work item id.' }) }),
    async execute({ id }) {
      const item = await getWorkItem(db, projectId, String(id));
      if (!item) throw new Error('work item not found');
      return JSON.stringify(item, null, 2);
    },
  });

  const update = defineTool({
    name: 'update_work_item',
    description:
      'Update progress on one of this project\'s work items. Allowed status values: running, waiting_approval, blocked, completed, failed.',
    parameters: Type.Object({
      id: Type.String({ description: 'Work item id.' }),
      status: Type.Optional(Type.String({ description: 'Allowed: running, waiting_approval, blocked, completed, failed.' })),
      statusNote: Type.Optional(Type.String({ description: 'Short note explaining the current progress or blocker.' })),
    }),
    async execute({ id, status, statusNote }) {
      if (!status && statusNote == null) throw new Error('status or statusNote is required');
      const item = await getWorkItem(db, projectId, String(id));
      if (!item) throw new Error('work item not found');
      const nextStatus = status == null ? item.status : String(status);
      if (!MODEL_WORK_ITEM_STATUSES.includes(nextStatus as (typeof MODEL_WORK_ITEM_STATUSES)[number])) {
        throw new Error(`status "${nextStatus}" is not allowed for the model`);
      }
      const updated = await updateWorkItemStatus(
        db,
        {
          projectId,
          id: String(id),
          status: nextStatus,
          statusNote: statusNote == null ? item.statusNote : String(statusNote),
          updatedByType: 'model',
          updatedById: 'agent',
        },
        deps,
      );
      return JSON.stringify(updated, null, 2);
    },
  });

  return [create, list, get, update];
}
