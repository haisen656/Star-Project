import { handleOptions, json, error } from '../_shared/http.ts';
import { admin } from '../_shared/supabase.ts';

const BUCKET = 'quickdrop-files';
async function removeSpaceFiles(spaceId: string): Promise<void> {
  const { data: items, error: itemError } = await admin.from('transfer_items').select('storage_path').eq('transfer_space_id', spaceId).not('storage_path', 'is', null);
  if (itemError) throw itemError;
  const paths = (items ?? []).flatMap((item) => item.storage_path ? [item.storage_path] : []);
  for (let index = 0; index < paths.length; index += 100) {
    const { error: removeError } = await admin.storage.from(BUCKET).remove(paths.slice(index, index + 100));
    if (removeError) throw removeError;
  }
}

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  if (request.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return error('未经授权的清理任务。', 401, 'UNAUTHORIZED');
  try {
    const now = new Date().toISOString();
    const { data: spaces, error: spaceError } = await admin.from('transfer_spaces').select('id').lte('expires_at', now);
    if (spaceError) throw spaceError;
    for (const space of spaces ?? []) { await removeSpaceFiles(space.id); await admin.from('transfer_spaces').delete().eq('id', space.id); }
    await admin.from('rate_limit_events').delete().lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    return json({ deletedSpaces: spaces?.length ?? 0 });
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : '清理失败。', 500, 'CLEANUP_FAILED');
  }
});
