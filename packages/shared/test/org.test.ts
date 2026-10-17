import { describe, expect, it } from 'vitest';
import { buildReportingTree, buildUnitTree, countDescendants, largestSpan } from '../src/org';

const p = (id: string, supervisorPersonId: string | null = null, orgUnitIds: string[] = []) => ({ id, supervisorPersonId, orgUnitIds });

describe('buildReportingTree', () => {
  it('nests people under their supervisors and returns roots', () => {
    const tree = buildReportingTree([p('ceo'), p('cto', 'ceo'), p('dev1', 'cto'), p('dev2', 'cto'), p('cfo', 'ceo')]);
    expect(tree.map((n) => n.item.id)).toEqual(['ceo']);
    expect(tree[0].children.map((n) => n.item.id)).toEqual(['cto', 'cfo']);
    expect(tree[0].children[0].children.map((n) => n.item.id)).toEqual(['dev1', 'dev2']);
    expect(countDescendants(tree[0])).toBe(4);
  });

  it('reports the largest number of direct reports anywhere in the forest', () => {
    const tree = buildReportingTree([p('ceo'), p('cto', 'ceo'), p('d1', 'cto'), p('d2', 'cto'), p('d3', 'cto'), p('solo')]);
    expect(largestSpan(tree)).toBe(3);
    expect(largestSpan([])).toBe(0);
  });

  it('treats people whose supervisor is unknown as roots', () => {
    const tree = buildReportingTree([p('a', 'gone'), p('b')]);
    expect(tree.map((n) => n.item.id).sort()).toEqual(['a', 'b']);
  });

  it('breaks supervisor cycles instead of looping or dropping people', () => {
    const tree = buildReportingTree([p('a', 'b'), p('b', 'a'), p('c', 'a')]);
    const all: string[] = [];
    const walk = (ns: typeof tree) => ns.forEach((n) => (all.push(n.item.id), walk(n.children)));
    walk(tree);
    expect(all.sort()).toEqual(['a', 'b', 'c']);
    expect(tree.length).toBeGreaterThanOrEqual(1);
  });
});

describe('buildUnitTree', () => {
  it('nests units by parent and attaches members', () => {
    const units = [
      { id: 'eng', parentId: null },
      { id: 'platform', parentId: 'eng' },
      { id: 'hr', parentId: null },
    ];
    const tree = buildUnitTree(units, [p('x', null, ['platform']), p('y', null, ['eng']), p('z')]);
    expect(tree.map((n) => n.unit.id)).toEqual(['eng', 'hr']);
    expect(tree[0].members.map((m) => m.id)).toEqual(['y']);
    expect(tree[0].children[0].members.map((m) => m.id)).toEqual(['x']);
  });

  it('survives parent cycles', () => {
    const tree = buildUnitTree([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }], []);
    expect(tree.length).toBe(1);
  });
});
