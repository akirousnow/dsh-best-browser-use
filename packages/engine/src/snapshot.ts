import { UNTRUSTED_PAGE_CONTENT_NOTICE } from './prompt.js';

/** Raw CDP AXNode shape returned by Accessibility.getFullAXTree. */
export interface RawAxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { type: string; value?: string };
  name?: { type: string; value?: string };
  value?: { type: string; value?: string };
  description?: { type: string; value?: string };
  properties?: Array<{ name: string; value?: { type: string; value?: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  nth: number;
  depth: number;
  interactive: boolean;
  value?: string;
  checked?: boolean | 'mixed';
  selected?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  level?: number;
  placeholder?: string;
  href?: string;
  backendDOMNodeId?: number;
  /** Stable fingerprint used for incremental diff matching across snapshots. */
  key: string;
  /** Compact single-line textual representation shown to the Agent. */
  line: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  capturedAt: number;
  elements: SnapshotElement[];
  refMap: Map<string, SnapshotElement>;
  truncated: boolean;
  totalCandidateCount: number;
}

export interface SnapshotDiffResult {
  kind: 'full' | 'diff';
  reason: 'initial' | 'url_changed' | 'major_change' | 'incremental';
  url: string;
  title: string;
  text: string;
  addedCount: number;
  changedCount: number;
  removedCount: number;
  totalElements: number;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'spinbutton',
  'treeitem',
]);

const STRUCTURAL_SEMANTIC_ROLES = new Set([
  'heading',
  'navigation',
  'main',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'img',
  'table',
  'row',
  'cell',
  'columnheader',
  'StaticText',
]);

function normalizeText(raw: string | undefined, maxLen = 140): string {
  if (!raw) return '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1)}…`;
}

function getAxProp(node: RawAxNode, propName: string): unknown {
  const prop = node.properties?.find((p) => p.name === propName);
  return prop?.value?.value;
}

function formatElementLine(el: Omit<SnapshotElement, 'line'>): string {
  const indent = '  '.repeat(Math.min(el.depth, 6));
  const attrs: string[] = [];
  if (el.level !== undefined) attrs.push(`level=${el.level}`);
  if (el.value !== undefined && el.value.length > 0) attrs.push(`value=${JSON.stringify(el.value)}`);
  if (el.checked === true) attrs.push('checked');
  if (el.checked === 'mixed') attrs.push('checked=mixed');
  if (el.selected === true) attrs.push('selected');
  if (el.expanded === true) attrs.push('expanded');
  if (el.expanded === false) attrs.push('collapsed');
  if (el.disabled === true) attrs.push('disabled');
  if (el.placeholder) attrs.push(`placeholder=${JSON.stringify(el.placeholder)}`);
  if (el.href) attrs.push(`href=${JSON.stringify(el.href)}`);

  const refTag = el.ref ? `[${el.ref}] ` : '';
  const namePart = el.name ? ` ${JSON.stringify(el.name)}` : '';
  const attrPart = attrs.length > 0 ? ` (${attrs.join(', ')})` : '';
  return `${indent}- ${refTag}${el.role}${namePart}${attrPart}`;
}

/**
 * Build a compact, token-efficient PageSnapshot from a raw CDP `Accessibility.getFullAXTree` response.
 * Assigns short refs (`e1`, `e2`, ...) to interactive elements and named semantic targets.
 */
export function buildSnapshotFromAXTree(
  nodes: RawAxNode[],
  meta: { url: string; title: string; maxElements?: number },
): PageSnapshot {
  const maxElements = meta.maxElements ?? 350;
  const byId = new Map<string, RawAxNode>();
  const childSet = new Set<string>();

  for (const node of nodes) {
    byId.set(node.nodeId, node);
    for (const cid of node.childIds ?? []) {
      childSet.add(cid);
    }
  }

  const roots = nodes.filter((n) => !childSet.has(n.nodeId));
  const startNodes = roots.length > 0 ? roots : nodes.slice(0, 1);

  const roleNameCounts = new Map<string, number>();
  const elements: SnapshotElement[] = [];
  const refMap = new Map<string, SnapshotElement>();
  let refCounter = 1;
  let totalCandidateCount = 0;

  const visit = (node: RawAxNode, depth: number, parentName: string): void => {
    const rawRole = String(node.role?.value ?? '');
    const name = normalizeText(node.name?.value);
    const value = node.value?.value !== undefined ? normalizeText(String(node.value.value), 120) : undefined;

    const isInteractive = !node.ignored && INTERACTIVE_ROLES.has(rawRole);
    const isStaticText = !node.ignored && rawRole === 'StaticText';
    const isStructural = !node.ignored && STRUCTURAL_SEMANTIC_ROLES.has(rawRole) && !isStaticText;

    let include = false;
    let role = rawRole;

    if (isInteractive) {
      include = true;
    } else if (isStructural && name.length > 0) {
      include = true;
    } else if (isStaticText && name.length >= 2 && name !== parentName) {
      include = true;
      role = 'text';
    }

    let nextDepth = depth;
    if (include) {
      totalCandidateCount++;
      if (elements.length < maxElements) {
        const pairKey = `${role}::${name}`;
        const nth = roleNameCounts.get(pairKey) ?? 0;
        roleNameCounts.set(pairKey, nth + 1);

        const ref = isInteractive || role === 'heading' ? `e${refCounter++}` : '';
        const checkedRaw = getAxProp(node, 'checked');
        const checked: boolean | 'mixed' | undefined =
          checkedRaw === 'true' || checkedRaw === true
            ? true
            : checkedRaw === 'mixed'
              ? 'mixed'
              : undefined;
        const selected = getAxProp(node, 'selected') === true ? true : undefined;
        const disabled = getAxProp(node, 'disabled') === true ? true : undefined;
        const expandedRaw = getAxProp(node, 'expanded');
        const expanded = typeof expandedRaw === 'boolean' ? expandedRaw : undefined;
        const levelRaw = getAxProp(node, 'level');
        const level = typeof levelRaw === 'number' ? levelRaw : undefined;
        const placeholderRaw = getAxProp(node, 'placeholder');
        const placeholder = typeof placeholderRaw === 'string' && placeholderRaw ? normalizeText(placeholderRaw, 60) : undefined;
        const urlRaw = getAxProp(node, 'url');
        const href = typeof urlRaw === 'string' && urlRaw ? normalizeText(urlRaw, 100) : undefined;

        const baseEl: Omit<SnapshotElement, 'line'> = {
          ref,
          role,
          name,
          nth,
          depth,
          interactive: isInteractive,
          ...(value !== undefined ? { value } : {}),
          ...(checked !== undefined ? { checked } : {}),
          ...(selected !== undefined ? { selected } : {}),
          ...(disabled !== undefined ? { disabled } : {}),
          ...(expanded !== undefined ? { expanded } : {}),
          ...(level !== undefined ? { level } : {}),
          ...(placeholder !== undefined ? { placeholder } : {}),
          ...(href !== undefined ? { href } : {}),
          ...(node.backendDOMNodeId !== undefined ? { backendDOMNodeId: node.backendDOMNodeId } : {}),
          key: `${role}|${name}|${nth}`,
        };

        const fullEl: SnapshotElement = {
          ...baseEl,
          line: formatElementLine(baseEl),
        };
        elements.push(fullEl);
        if (ref) {
          refMap.set(ref, fullEl);
        }
      }
      nextDepth = depth + 1;
    }

    for (const cid of node.childIds ?? []) {
      const child = byId.get(cid);
      if (child) {
        visit(child, nextDepth, name || parentName);
      }
    }
  };

  for (const root of startNodes) {
    visit(root, 0, '');
  }

  return {
    url: meta.url,
    title: meta.title,
    capturedAt: Date.now(),
    elements,
    refMap,
    truncated: totalCandidateCount > elements.length,
    totalCandidateCount,
  };
}

/** Render a complete snapshot as model-facing markdown/text with prompt-injection header. */
export function renderFullSnapshot(snapshot: PageSnapshot, pendingDialog?: string): string {
  const lines: string[] = [
    UNTRUSTED_PAGE_CONTENT_NOTICE,
    `Page: ${snapshot.title || '(untitled)'}`,
    `URL: ${snapshot.url}`,
  ];
  if (pendingDialog) {
    lines.push(`Pending Dialog: ${pendingDialog}`);
  }
  lines.push('');

  if (snapshot.elements.length === 0) {
    lines.push('(empty page or no accessible elements)');
  } else {
    for (const el of snapshot.elements) {
      lines.push(el.line);
    }
  }

  if (snapshot.truncated) {
    lines.push('');
    lines.push(
      `(Showing ${snapshot.elements.length} of ${snapshot.totalCandidateCount} elements; navigate or narrow focus to inspect more.)`,
    );
  }

  return lines.join('\n');
}

function elementStateSignature(el: SnapshotElement): string {
  return JSON.stringify({
    v: el.value ?? null,
    c: el.checked ?? null,
    s: el.selected ?? null,
    d: el.disabled ?? null,
    e: el.expanded ?? null,
    h: el.href ?? null,
  });
}

/**
 * Compute an incremental snapshot diff between `prev` and `next`.
 * Automatically falls back to full snapshot when:
 * - No previous snapshot exists
 * - URL changed
 * - Over 50% of elements changed/added/removed (avoids noisy diffs that waste tokens)
 */
export function diffSnapshots(
  prev: PageSnapshot | undefined,
  next: PageSnapshot,
  pendingDialog?: string,
): SnapshotDiffResult {
  if (!prev) {
    return {
      kind: 'full',
      reason: 'initial',
      url: next.url,
      title: next.title,
      text: renderFullSnapshot(next, pendingDialog),
      addedCount: next.elements.length,
      changedCount: 0,
      removedCount: 0,
      totalElements: next.elements.length,
    };
  }

  if (prev.url !== next.url) {
    return {
      kind: 'full',
      reason: 'url_changed',
      url: next.url,
      title: next.title,
      text: renderFullSnapshot(next, pendingDialog),
      addedCount: next.elements.length,
      changedCount: 0,
      removedCount: prev.elements.length,
      totalElements: next.elements.length,
    };
  }

  const prevByKey = new Map<string, SnapshotElement>();
  for (const el of prev.elements) {
    prevByKey.set(el.key, el);
  }

  const nextKeys = new Set<string>();
  const added: SnapshotElement[] = [];
  const changed: Array<{ before: SnapshotElement; after: SnapshotElement }> = [];

  for (const el of next.elements) {
    nextKeys.add(el.key);
    const old = prevByKey.get(el.key);
    if (!old) {
      added.push(el);
    } else if (elementStateSignature(old) !== elementStateSignature(el)) {
      changed.push({ before: old, after: el });
    }
  }

  let removedCount = 0;
  for (const el of prev.elements) {
    if (!nextKeys.has(el.key)) {
      removedCount++;
    }
  }

  const denom = Math.max(1, prev.elements.length, next.elements.length);
  const deltaTotal = added.length + changed.length + removedCount;
  if (deltaTotal / denom > 0.5) {
    return {
      kind: 'full',
      reason: 'major_change',
      url: next.url,
      title: next.title,
      text: renderFullSnapshot(next, pendingDialog),
      addedCount: added.length,
      changedCount: changed.length,
      removedCount,
      totalElements: next.elements.length,
    };
  }

  const lines: string[] = [
    UNTRUSTED_PAGE_CONTENT_NOTICE,
    `Snapshot Diff — ${next.title || '(untitled)'} (${next.url})`,
  ];
  if (pendingDialog) {
    lines.push(`Pending Dialog: ${pendingDialog}`);
  }

  if (added.length === 0 && changed.length === 0 && removedCount === 0) {
    lines.push('(No accessibility tree changes detected.)');
  } else {
    for (const el of added) {
      lines.push(`+ ${el.line.trimStart()}`);
    }
    for (const pair of changed) {
      lines.push(`~ ${pair.after.line.trimStart()}`);
    }
    if (removedCount > 0) {
      lines.push(`- ${removedCount} element${removedCount === 1 ? '' : 's'} removed`);
    }
  }

  return {
    kind: 'diff',
    reason: 'incremental',
    url: next.url,
    title: next.title,
    text: lines.join('\n'),
    addedCount: added.length,
    changedCount: changed.length,
    removedCount,
    totalElements: next.elements.length,
  };
}
