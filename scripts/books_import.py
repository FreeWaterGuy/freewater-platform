"""Turn the two books into clean markdown the platform reads (books/*.md).

  python3 scripts/books_import.py <manual.pdf> <engineering.docx>

Needs pdftotext and pandoc. Run again when a new edition arrives, then update books/index.json (version, date).
The markdown is the copy the agents read; the original files stay with the author.
"""
import re, subprocess, sys, unicodedata

LIG = {'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl', ' ': ' '}
def clean(s):
    for k, v in LIG.items(): s = s.replace(k, v)
    return s

def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', clean(s).lower()).strip()

def manual(pdf, out):
    text = clean(subprocess.run(['pdftotext', pdf, '-'], capture_output=True, text=True, check=True).stdout)
    lines = text.split('\n')
    # The table of contents: chapter titles and their sections, in order.
    toc_end = next(i for i, l in enumerate(lines) if l.strip() == 'Special Thanks' or l.startswith('Special Thanks'))
    chapters = []  # (num, title, [sections])
    entry = re.compile(r'^(.*?)\s*\.{3,}\s*\d+\s*$')
    pending = ''
    for l in lines[:toc_end + 1]:
        s = l.strip()
        if not s: continue
        m = entry.match(s)
        if not m:
            pending = (pending + ' ' + s).strip() if pending or s.startswith('Chapter') or s.startswith('PART') else ''
            continue
        t = (pending + ' ' + m.group(1)).strip() if pending else m.group(1).strip()
        pending = ''
        cm = re.match(r'^Chapter (\d+):\s*(.*)$', t)
        if cm: chapters.append([int(cm.group(1)), cm.group(2).strip(), []])
        elif t.startswith('PART') or not chapters: continue
        else: chapters[-1][2].append(t)
    body = lines[toc_end + 1:]
    # Find where each chapter starts in the body, in order.
    starts = []
    pos = 0
    for num, title, _ in chapters:
        for i in range(pos, len(body)):
            if re.match(r'^Chapter %d:' % num, body[i].strip()):
                starts.append(i); pos = i + 1; break
        else:
            raise SystemExit(f'Chapter {num} not found in the body')
    md = ['# How to Make a Free Product Company (Second Edition)', '', '_Josh Cliffords, 2026. The operating manual: business models and how to run them._', '']
    for idx, (num, title, sections) in enumerate(chapters):
        a = starts[idx]; b = starts[idx + 1] if idx + 1 < len(starts) else len(body)
        chunk = body[a:b]
        # Skip the wrapped title lines.
        head = norm(f'Chapter {num}: {title}')
        k = 0; acc = ''
        while k < len(chunk) and len(norm(acc)) < len(head):
            acc += ' ' + chunk[k]; k += 1
        md += [f'## Chapter {num}: {title}', '']
        secs = {norm(s): s for s in sections}
        para = []
        def flush():
            if para:
                md.append(re.sub(r'\s+', ' ', ' '.join(para)).strip()); md.append(''); para.clear()
        for l in chunk[k:]:
            s = l.strip()
            if re.match(r'^PART \d', s): flush(); continue
            if re.fullmatch(r'\d{1,3}', s): continue  # page numbers
            if not s: flush(); continue
            if norm(s) in secs:
                flush(); md += [f'### {secs.pop(norm(s))}', '']; continue
            para.append(s)
        flush()
    # Page breaks split paragraphs mid-sentence: join a paragraph to the next when it doesn't end a sentence and the
    # next carries on in lower case (or the first is only a bullet mark).
    joined = []
    for line in md:
        if joined and line and joined[-1] == '' and len(joined) >= 2:
            prev = joined[-2]
            if prev and not prev.startswith('#') and not line.startswith('#') and (prev.strip() == '•' or (not re.search(r'[.!?:"”’)\]]$', prev) and re.match(r'^[a-z(“"—–-]', line))):
                joined.pop(); joined[-1] = (prev.rstrip() + ' ' + line.lstrip()).replace('• ', '• ', 1); continue
        joined.append(line)
    text = '\n'.join(joined)
    text = re.sub(r'^(• ?)+', '- ', text, flags=re.M)
    open(out, 'w').write(text.rstrip() + '\n')
    print(f'{out}: {len(chapters)} chapters')

def engineering(docx, out):
    md = subprocess.run(['pandoc', docx, '-t', 'gfm', '--wrap=none'], capture_output=True, text=True, check=True).stdout
    md = clean(md)
    lines = md.split('\n')
    # Drop the table of contents (everything from its heading to the Abstract).
    try:
        a = next(i for i, l in enumerate(lines) if re.match(r'^#+ .*Table of Contents', l))
        b = next(i for i, l in enumerate(lines) if i > a and re.match(r'^#+ .*Abstract', l))
        lines = lines[:a] + lines[b:]
    except StopIteration:
        pass
    outl = []
    for l in lines:
        if l.startswith('<img') or l.startswith('!['): continue
        if re.match(r'^#+\s', l):
            l = re.sub(r'\*\*', '', l).rstrip()
            l = re.sub(r'\s*\{#[^}]*\}', '', l)
            if re.match(r'^#+\s*$', l): continue
        outl.append(l)
    text = '\n'.join(outl)
    text = re.sub(r'^\*\*\s*$\n?', '', text, flags=re.M)
    text = re.sub(r'\n{3,}', '\n\n', text)
    # One top-level title; parts and chapters become ## and the rest keep their depth below.
    text = re.sub(r'^### Abundance Engineering\s*$', '# Abundance Engineering', text, count=1, flags=re.M)
    open(out, 'w').write(text.strip() + '\n')
    print(f'{out}: done')

if __name__ == '__main__':
    manual(sys.argv[1], 'books/free-product-company-2e.md')
    engineering(sys.argv[2], 'books/abundance-engineering-2026-10-08.md')
