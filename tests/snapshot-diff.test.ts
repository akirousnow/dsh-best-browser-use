import { describe, expect, it } from 'vitest';
import {
  buildSnapshotFromAXTree,
  diffSnapshots,
  renderFullSnapshot,
  UNTRUSTED_PAGE_CONTENT_NOTICE,
  type RawAxNode,
} from '../packages/engine/src/index.js';

function makeFormTree(emailValue = '', submittedMessage?: string): RawAxNode[] {
  const nodes: RawAxNode[] = [
    {
      nodeId: '1',
      role: { type: 'role', value: 'RootWebArea' },
      name: { type: 'computedString', value: 'Sign In' },
      childIds: ['2', '3', '4', '5', '6', ...(submittedMessage ? ['7'] : [])],
    },
    {
      nodeId: '2',
      role: { type: 'role', value: 'heading' },
      name: { type: 'computedString', value: 'Account Login' },
      properties: [{ name: 'level', value: { type: 'integer', value: 1 } }],
    },
    {
      nodeId: '3',
      role: { type: 'role', value: 'textbox' },
      name: { type: 'computedString', value: 'Email' },
      value: { type: 'string', value: emailValue },
      backendDOMNodeId: 101,
    },
    {
      nodeId: '4',
      role: { type: 'role', value: 'textbox' },
      name: { type: 'computedString', value: 'Password' },
      value: { type: 'string', value: '' },
      backendDOMNodeId: 102,
    },
    {
      nodeId: '5',
      role: { type: 'role', value: 'checkbox' },
      name: { type: 'computedString', value: 'Remember me' },
      properties: [{ name: 'checked', value: { type: 'tristate', value: 'false' } }],
    },
    {
      nodeId: '6',
      role: { type: 'role', value: 'button' },
      name: { type: 'computedString', value: 'Continue' },
    },
  ];
  if (submittedMessage) {
    nodes.push({
      nodeId: '7',
      role: { type: 'role', value: 'status' },
      name: { type: 'computedString', value: submittedMessage },
    });
  }
  return nodes;
}

describe('AXTree snapshot & incremental Diff', () => {
  it('assigns compact refs and includes anti-prompt-injection header', () => {
    const snap = buildSnapshotFromAXTree(makeFormTree(), {
      url: 'https://app.example.com/login',
      title: 'Sign In',
    });

    expect(snap.elements.length).toBe(5);
    expect(snap.refMap.get('e1')?.role).toBe('heading');
    expect(snap.refMap.get('e2')?.role).toBe('textbox');
    expect(snap.refMap.get('e2')?.name).toBe('Email');
    expect(snap.refMap.get('e5')?.role).toBe('button');

    const text = renderFullSnapshot(snap);
    expect(text).toContain(UNTRUSTED_PAGE_CONTENT_NOTICE);
    expect(text).toContain('[e2] textbox "Email"');
    expect(text).toContain('[e5] button "Continue"');
  });

  it('produces compact incremental diff after small state changes', () => {
    const before = buildSnapshotFromAXTree(makeFormTree(''), {
      url: 'https://app.example.com/login',
      title: 'Sign In',
    });
    const after = buildSnapshotFromAXTree(makeFormTree('alice@example.com', 'Code sent'), {
      url: 'https://app.example.com/login',
      title: 'Sign In',
    });

    const diff = diffSnapshots(before, after);
    expect(diff.kind).toBe('diff');
    expect(diff.reason).toBe('incremental');
    expect(diff.changedCount).toBe(1);
    expect(diff.addedCount).toBe(1);
    expect(diff.removedCount).toBe(0);
    expect(diff.text).toContain('~ - [e2] textbox "Email" (value="alice@example.com")');
    expect(diff.text).toContain('+ - status "Code sent"');
    expect(diff.text).not.toContain('Password');
  });

  it('falls back to full snapshot when URL changes or >50% of page changes', () => {
    const before = buildSnapshotFromAXTree(makeFormTree(), {
      url: 'https://app.example.com/login',
      title: 'Sign In',
    });
    const afterUrlChange = buildSnapshotFromAXTree(makeFormTree(), {
      url: 'https://app.example.com/dashboard',
      title: 'Dashboard',
    });
    const diffUrl = diffSnapshots(before, afterUrlChange);
    expect(diffUrl.kind).toBe('full');
    expect(diffUrl.reason).toBe('url_changed');

    const totallyDifferentNodes: RawAxNode[] = [
      {
        nodeId: '1',
        role: { type: 'role', value: 'RootWebArea' },
        childIds: ['10', '11', '12', '13'],
      },
      { nodeId: '10', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'A' } },
      { nodeId: '11', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'B' } },
      { nodeId: '12', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'C' } },
      { nodeId: '13', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'D' } },
    ];
    const afterMajor = buildSnapshotFromAXTree(totallyDifferentNodes, {
      url: 'https://app.example.com/login',
      title: 'Sign In',
    });
    const diffMajor = diffSnapshots(before, afterMajor);
    expect(diffMajor.kind).toBe('full');
    expect(diffMajor.reason).toBe('major_change');
  });
});
