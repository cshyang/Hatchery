import { bindingByProject as defaultBindingByProject, type Binding } from './bindings';
import {
  sendToConversationTarget as defaultSendToConversationTarget,
  topLevelTargetFromBinding,
  type ConversationTarget,
} from './conversations';
import type { D1Like } from './skills';

type BindingLookup = (projectId: string, db?: D1Like) => Promise<Binding | undefined>;
type NoticeSender = (env: Record<string, unknown>, target: ConversationTarget, text: string) => Promise<void>;

export interface PostConnectionNoticeInput {
  db: D1Like;
  env: Record<string, unknown>;
  projectId: string;
  text: string;
}

export interface PostConnectionNoticeDeps {
  bindingByProject?: BindingLookup;
  sendToConversationTarget?: NoticeSender;
  log?: (message: string) => void;
}

// Best-effort channel notice for connection lifecycle events. The connection row is the source of
// truth; a Slack hiccup must not fail the webhook after D1 has already accepted the state change.
export async function postConnectionNotice(
  { db, env, projectId, text }: PostConnectionNoticeInput,
  deps: PostConnectionNoticeDeps = {},
): Promise<void> {
  const bindingByProject = deps.bindingByProject ?? defaultBindingByProject;
  const sendToConversationTarget = deps.sendToConversationTarget ?? defaultSendToConversationTarget;
  const log = deps.log ?? console.log;

  const binding = await bindingByProject(projectId, db).catch(() => undefined);
  if (!binding) return;

  const target = topLevelTargetFromBinding(binding);
  await sendToConversationTarget(env, target, text).catch((e) =>
    log(`[nango] channel notice failed to post: ${e instanceof Error ? e.message : 'error'}`),
  );
}
