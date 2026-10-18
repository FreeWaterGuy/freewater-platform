import sys,os
from playwright.sync_api import sync_playwright
from PIL import Image
S='/tmp/claude-0/-home-claude/dbb21ec3-4d49-596e-9815-8cf7825a54d8/scratchpad/'
FS=S+'node_modules/@fontsource/'
css=''
for fam,d,ws in [('Comfortaa','comfortaa',[300,700]),('DM Sans','dm-sans',[400,500,700])]:
    for w in ws:
        css+=f"@font-face{{font-family:'{fam}';font-weight:{w};src:url('file://{FS}{d}/files/{d}-latin-{w}-normal.woff2')}}"
names=sys.argv[1:]
with sync_playwright() as p:
    b=p.chromium.launch()
    for n in names:
        nm,w,h=n.split(':');w=int(w);h=int(h)
        pg=b.new_page(viewport={'width':w,'height':h})
        pg.goto('file://'+S+'blueprint/project/'+nm+'.dc.html');pg.add_style_tag(content=css);pg.wait_for_timeout(600)
        pg.screenshot(path=S+nm+'.png');pg.close()
    b.close()
