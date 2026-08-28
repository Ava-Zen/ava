export interface FolderChoice {
  path: string;
  name?: string;
}

export function folderName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

export function normalizeFolderKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/\b(project|repo|repository|codebase|folder)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pick a unique best folder for a spoken project name, or null if the user should choose. */
export function matchFolderByHint(hint: string, folders: FolderChoice[]): string | null {
  const key = normalizeFolderKey(hint);
  if (key.length < 2) return null;

  const ranked: { path: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const path = folder.path.trim();
    if (!path) continue;
    const id = path.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const base = normalizeFolderKey(folderName(path));
    const label = normalizeFolderKey(folder.name || '');
    const full = normalizeFolderKey(path);
    let score = 0;
    if (base === key || label === key) score = 100;
    else if (base.startsWith(key) || label.startsWith(key)) score = 80;
    else if (base.includes(key) || label.includes(key)) score = 60;
    else if (full.includes(key)) score = 40;
    if (score) ranked.push({ path, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
  return ranked[0].path;
}

export function uniqueFolders(folders: FolderChoice[]): FolderChoice[] {
  const seen = new Set<string>();
  const out: FolderChoice[] = [];
  for (const folder of folders) {
    const path = folder.path.trim();
    if (!path) continue;
    const id = path.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ path, name: folder.name?.trim() || undefined });
  }
  return out;
}
