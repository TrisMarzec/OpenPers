import type { ReactNode } from 'react';

/** Minimal, safe Markdown renderer (headings, lists, paragraphs, **bold**) – no raw HTML. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let list: string[] = [];
  let para: string[] = [];
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={blocks.length} className="my-2 list-disc pl-5">
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
    if (para.length) {
      blocks.push(
        <p key={blocks.length} className="my-2">
          {inline(para.join(' '))}
        </p>,
      );
      para = [];
    }
  };
  for (const line of lines) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push(
        <h3 key={blocks.length} className={h[1].length === 1 ? 'mt-5 text-xl font-bold' : 'mt-4 text-lg font-bold'}>
          {h[2]}
        </h3>,
      );
    } else if (li) {
      if (para.length) flush();
      list.push(li[1]);
    } else if (!line.trim()) flush();
    else {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <div className="max-w-[72ch] leading-relaxed">{blocks}</div>;
}
