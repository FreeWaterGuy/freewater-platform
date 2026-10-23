#!/usr/bin/env python3
"""
Builds the fonts the label printer draws words with (src/modules/print/fonts/files/). Run by a person when the set of
fonts changes; the output is committed, so the server and CI need neither Python nor these system fonts.

  python3 -I scripts/fonts/build-fonts.py /usr/share/fonts/truetype

Each font is cut down to the letters a label uses (pyftsubset, fontTools) with its hinting and layout tables left out,
and its kerning (GPOS pair adjustments, or the old kern table) is written beside it as <name>.kern.json: pairs of
characters and the adjustment in font units. Every font here is under the SIL Open Font License 1.1 (Poppins,
Liberation) or the Bitstream Vera / DejaVu licence; their licence texts are copied beside them. Cut-down copies are
renamed "FW Label …" as those licences require of a modified font.
"""
import json, os, sys
from fontTools.ttLib import TTFont
from fontTools import subset

SRC = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/truetype'
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'modules', 'print', 'fonts', 'files')
LATIN = 'U+0020-007E,U+00A0-024F,U+0300-036F,U+1E00-1EFF,U+2010-2027,U+2030-203A,U+2044,U+20AC,U+20B9,U+2122,U+2190-2193,U+2212,U+2215'
WIDE = LATIN + ',U+0370-03FF,U+0400-04FF'
FALLBACK = WIDE + ',U+0590-05FF,U+0600-06FF,U+FB1D-FB4F,U+FB50-FDFF,U+FE70-FEFF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2150-218F,U+2200-22FF,U+25A0-25FF'
FONTS = [
  # name, file, unicodes
  ('poppins-300', 'google-fonts/Poppins-Light.ttf', LATIN),
  ('poppins-400', 'google-fonts/Poppins-Regular.ttf', LATIN),
  ('poppins-500', 'google-fonts/Poppins-Medium.ttf', LATIN),
  ('poppins-700', 'google-fonts/Poppins-Bold.ttf', LATIN),
  ('poppins-400i', 'google-fonts/Poppins-Italic.ttf', LATIN),
  ('poppins-700i', 'google-fonts/Poppins-BoldItalic.ttf', LATIN),
  ('sans-400', 'liberation/LiberationSans-Regular.ttf', WIDE + ',U+0590-05FF'),
  ('sans-700', 'liberation/LiberationSans-Bold.ttf', WIDE + ',U+0590-05FF'),
  ('sans-400i', 'liberation/LiberationSans-Italic.ttf', WIDE),
  ('sans-700i', 'liberation/LiberationSans-BoldItalic.ttf', WIDE),
  ('serif-400', 'liberation/LiberationSerif-Regular.ttf', WIDE + ',U+0590-05FF'),
  ('serif-700', 'liberation/LiberationSerif-Bold.ttf', WIDE + ',U+0590-05FF'),
  ('narrow-400', 'dejavu/DejaVuSansCondensed.ttf', WIDE),
  ('narrow-700', 'dejavu/DejaVuSansCondensed-Bold.ttf', WIDE),
  ('fallback-400', 'dejavu/DejaVuSans.ttf', FALLBACK),
  ('fallback-700', 'dejavu/DejaVuSans-Bold.ttf', FALLBACK),
]

def kerning(font, cmap):
  """Every pair of characters the font kerns, from GPOS PairPos (formats 1 and 2) or the kern table."""
  by_glyph = {}
  for cp, g in cmap.items():
    if cp < 0x2000 or 0x2010 <= cp <= 0x203A: by_glyph.setdefault(g, []).append(cp)
  out = {}
  def put(g1, g2, v):
    if not v: return
    for a in by_glyph.get(g1, []):
      for b in by_glyph.get(g2, []):
        k = chr(a) + chr(b)
        if k not in out: out[k] = v
  if 'GPOS' in font:
    gpos = font['GPOS'].table
    kern_lookups = set()
    for fr in gpos.FeatureList.FeatureRecord:
      if fr.FeatureTag == 'kern': kern_lookups.update(fr.Feature.LookupListIndex)
    for i in sorted(kern_lookups):
      lk = gpos.LookupList.Lookup[i]
      subs = lk.SubTable
      if lk.LookupType == 9: subs = [s.ExtSubTable for s in subs]
      for st in subs:
        if getattr(st, 'LookupType', 2) != 2 and lk.LookupType != 9: continue
        cov = st.Coverage.glyphs
        if st.Format == 1:
          for g1, ps in zip(cov, st.PairSet):
            for r in ps.PairValueRecord:
              v = getattr(r.Value1, 'XAdvance', 0) if r.Value1 else 0
              put(g1, r.SecondGlyph, v)
        elif st.Format == 2:
          c1 = st.ClassDef1.classDefs; c2 = st.ClassDef2.classDefs
          seconds = {}
          for g, c in c2.items(): seconds.setdefault(c, []).append(g)
          for g1 in cov:
            rec = st.Class1Record[c1.get(g1, 0)]
            for cls2, r2 in enumerate(rec.Class2Record):
              v = getattr(r2.Value1, 'XAdvance', 0) if r2.Value1 else 0
              if not v or cls2 == 0: continue
              for g2 in seconds.get(cls2, []): put(g1, g2, v)
  if not out and 'kern' in font:
    for t in font['kern'].kernTables:
      for (g1, g2), v in t.kernTable.items(): put(g1, g2, v)
  return out

os.makedirs(OUT, exist_ok=True)
for name, rel, unicodes in FONTS:
  src = os.path.join(SRC, rel)
  full = TTFont(src)
  cmap = full.getBestCmap()
  kern = kerning(full, cmap)
  opts = subset.Options()
  opts.layout_features = []
  opts.hinting = False
  opts.drop_tables += ['GPOS', 'GSUB', 'GDEF', 'kern', 'DSIG', 'FFTM']
  opts.name_IDs = ['*']; opts.name_languages = ['*']
  opts.notdef_outline = True
  f = TTFont(src)
  s = subset.Subsetter(opts)
  s.populate(unicodes=subset.parse_unicodes(unicodes))
  s.subset(f)
  # A cut-down font is a Modified Version under the OFL: it may not carry the original's Reserved Font Names
  # (Liberation, Arimo, Tinos; Bitstream and Vera under the DejaVu licence), so it is renamed.
  family = 'FW Label ' + name.split('-')[0].capitalize()
  style = name.split('-')[1]
  for rec in f['name'].names:
    if rec.nameID in (1, 16): rec.string = family
    elif rec.nameID in (3, 4): rec.string = f'{family} {style}'
    elif rec.nameID == 6: rec.string = f'FWLabel{name.split("-")[0].capitalize()}-{style}'
    elif rec.nameID in (17, 18, 21, 22): rec.string = style
  dest = os.path.join(OUT, name + '.ttf')
  f.save(dest)
  kept = set(f.getBestCmap().keys())
  kern = {k: v for k, v in kern.items() if ord(k[0]) in kept and ord(k[1]) in kept}
  with open(os.path.join(OUT, name + '.kern.json'), 'w') as fh: json.dump(kern, fh, separators=(',', ':'), ensure_ascii=False, sort_keys=True)
  print(f'{name}: {os.path.getsize(dest)//1024} KB, {len(kept)} characters, {len(kern)} kerning pairs')
