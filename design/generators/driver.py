import sys,json
P=sys.argv[1]
INK='#1d2433';G1='#e6e9ef';G2='#f1f3f6';B='#c3c9d4';T2='#5b6475';T3='#8a93a3'
MONO="font-family: 'IBM Plex Mono', monospace"
def lab(t): return f'<div style="{MONO}; font-size: 11px; letter-spacing: 0.12em; color: {T2}">{t}</div>'
def big(t,href,dark=True,h=56):
    s=f'background: {INK}; color: #fff' if dark else f'border: 2px solid {INK}'
    return f'<a href="{href}" style="display: flex; align-items: center; justify-content: center; height: {h}px; border-radius: {h//2}px; {s}; font-size: 17px; font-weight: 600; text-decoration: none">{t}</a>'
def ph(h,label):
    return f'<div style="position: relative; height: {h}; border-radius: 14px; border: 1px solid {B}; background: {G2}; overflow: hidden; flex: none"><svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" style="position: absolute; inset: 0; width: 100%; height: 100%"><line x1="0" y1="0" x2="100" y2="100" stroke="#d3d8e0" stroke-width="0.6" vector-effect="non-scaling-stroke"/><line x1="100" y1="0" x2="0" y2="100" stroke="#d3d8e0" stroke-width="0.6" vector-effect="non-scaling-stroke"/></svg><div style="position: absolute; left: 10px; top: 10px; {MONO}; font-size: 11px; color: {T2}; background: #fff; padding: 3px 8px; border-radius: 6px">{label}</div></div>'
def boxcard(stop,pack,size,extra=''):
    return f'''<div style="border: 2px solid {INK}; border-radius: 16px; padding: 14px 16px; display: flex; align-items: center; gap: 14px{extra}">
<div style="width: 64px; height: 64px; flex: none; border-radius: 10px; background: {INK}; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center"><span style="{MONO}; font-size: 9px; letter-spacing: 0.1em; opacity: .8">STOP</span><span style="font-size: 28px; font-weight: 600; line-height: 30px">{stop}</span></div>
<div style="display: flex; flex-direction: column; gap: 2px"><span style="{MONO}; font-size: 11px; letter-spacing: 0.12em; color: {T2}">BOX TO GRAB</span><span style="font-size: 18px; font-weight: 600">{pack} · {size}</span><span style="font-size: 13px; color: {T2}">Stop code {stop} is printed small on the box corner</span></div></div>'''
def page(name,title,body,pad='52px 20px 24px'):
    html=f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&amp;family=IBM+Plex+Sans:wght@400;600&amp;display=swap">
<style>
body{{margin:0}}
a{{color:#1d2433}}a:hover{{color:#4b5468}}
</style>
</helmet>
<div style="width: 390px; height: 844px; box-sizing: border-box; background: #ffffff; font-family: 'IBM Plex Sans', 'Helvetica Neue', sans-serif; color: {INK}; display: flex; flex-direction: column; gap: 14px; padding: {pad}">
{body}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":390,"height":844}}}}'>
class Component extends DCLogic {{
renderVals() {{
return {{}};
}}
}}
</script>
</body>
</html>
'''
    open(P+name+'.dc.html','w').write(html)
def topbar(left,right):
    return f'<div style="display: flex; justify-content: space-between; align-items: center"><span style="font-size: 15px; font-weight: 600">{left}</span><span style="font-size: 13px; color: {T2}">{right}</span></div>'
def progress(a,b,label):
    return f'<div style="display: flex; flex-direction: column; gap: 6px"><div style="display: flex; justify-content: space-between; font-size: 13px; color: {T2}"><span>{label}</span><span style="font-weight: 600; color: {INK}">{a} of {b}</span></div><div style="height: 8px; border-radius: 4px; background: {G1}"><div style="width: {round(100*a/b)}%; height: 8px; border-radius: 4px; background: {INK}"></div></div></div>'

# D2 Load the van
rows=''.join(f'<div style="display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid {G1}"><span style="width: 36px; height: 36px; flex: none; border-radius: 8px; {"background: "+INK+"; color: #fff" if done else "border: 1px solid "+B}; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600">{s}</span><span style="flex: 1 1 auto; display: flex; flex-direction: column"><span style="font-size: 14px; font-weight: 600">{p}</span><span style="font-size: 12px; color: {T2}">{a}</span></span><span style="font-size: 13px; {"color: "+T2 if done else "font-weight: 600"}">{"Loaded ✓" if done else ("Now" if s=="24" else "Then")}</span></div>' for s,p,a,done in [("42","#8890 · 12-pack","2101 Alta Vista",True),("41","#8889 · 6-pack","2105 Alta Vista",True),("…","16 more loaded","",True),("24","#8836 · 24-pack","1702 Travis Heights Blvd",False),("23","#8835 · 12-pack","1706 Travis Heights Blvd",False)])
body=f'''{topbar("Route 3 · Van 1","Leaves 6:00 am")}
<div style="display: flex; flex-direction: column; gap: 4px"><div style="font-size: 24px; font-weight: 600">Load the van</div><div style="font-size: 14px; color: {T2}">Last stop goes in first, so stop 1 ends up by the door.</div></div>
{progress(18,46,"Packs loaded")}
{boxcard("24","#8836","24-pack")}
<div style="font-size: 13px; color: {T2}; margin-top: -4px">Put it on the left shelf, behind stop 25.</div>
<div style="display: flex; flex-direction: column">{rows}</div>
<div style="margin-top: auto">{big("Scan box to load","DriverNext.dc.html")}</div>'''
page('DriverLoad','D2 Load the van',body)

# D3 Next stop
nxt=''.join(f'<div style="display: flex; gap: 12px; font-size: 13px; padding: 8px 0; border-top: 1px solid {G1}"><span style="{MONO}; color: {T2}; width: 22px">{a}</span><span style="flex: 1 1 auto">{b}</span><span style="color: {T2}">{c}</span></div>' for a,b,c in [("15","1310 Kenwood Ave","next door"),("16","1314 Kenwood Ave","2 doors"),("17","1402 Kenwood Ave","across")])
body=f'''{topbar("Route 3 · Van 1","13 done · 29 to go")}
{ph("230px","MAP · YOU ARE HERE → NEXT HOUSE")}
<div style="display: flex; flex-direction: column; gap: 2px"><span style="{MONO}; font-size: 11px; letter-spacing: 0.12em; color: {T2}">STOP 14 OF 42 · 60 FT</span><span style="font-size: 30px; font-weight: 600; line-height: 36px">1306 Kenwood Ave</span><span style="font-size: 14px; color: {T2}">Leave at front door · 6 empties to pick up</span></div>
{boxcard("14","#8812","12-pack")}
<div style="display: flex; flex-direction: column">{lab("THEN")}{nxt}</div>
<div style="margin-top: auto">{big("I&#39;m at the door · scan box","DriverDoor.dc.html")}</div>'''
page('DriverNext','D3 Next stop',body)

# D3.1 At the door - match
body=f'''{topbar("Stop 14 · 1306 Kenwood Ave","6:41 am")}
<div style="background: {INK}; color: #fff; border-radius: 18px; padding: 20px; display: flex; flex-direction: column; gap: 6px; align-items: center; text-align: center">
<span style="width: 56px; height: 56px; border-radius: 28px; background: #fff; color: {INK}; display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 600">✓</span>
<span style="font-size: 24px; font-weight: 600">Right box</span>
<span style="font-size: 14px; opacity: .85">#8812 belongs to this house. GPS agrees.</span></div>
{ph("200px","PHOTO PROOF · BOX AT THE DOOR")}
<div style="border: 1px solid {B}; border-radius: 14px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center">
<span style="display: flex; flex-direction: column"><span style="font-size: 15px; font-weight: 600">Empties picked up</span><span style="font-size: 12px; color: {T2}">Expected 6</span></span>
<span style="display: flex; align-items: center; border: 1px solid {B}; border-radius: 22px; height: 44px"><span style="width: 44px; text-align: center; font-size: 20px">−</span><span style="font-size: 17px; font-weight: 600; width: 28px; text-align: center">6</span><span style="width: 44px; text-align: center; font-size: 20px">+</span></span></div>
<div style="margin-top: auto; display: flex; flex-direction: column; gap: 10px">{big("Done · next house","DriverNext.dc.html")}<a href="DriverWrong.dc.html" style="text-align: center; font-size: 14px; font-weight: 600">Problem at this stop</a></div>'''
page('DriverDoor','D3.1 At the door',body)

# D3.2 Wrong box
body=f'''{topbar("Stop 14 · 1306 Kenwood Ave","6:41 am")}
<div style="border: 3px solid {INK}; border-radius: 18px; padding: 20px; display: flex; flex-direction: column; gap: 6px; align-items: center; text-align: center; background: repeating-linear-gradient(135deg, #fff 0 10px, {G2} 10px 20px)">
<span style="width: 56px; height: 56px; border-radius: 28px; background: {INK}; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 600">!</span>
<span style="font-size: 24px; font-weight: 600">Wrong box. Don&#39;t leave it.</span>
<span style="font-size: 14px; color: {T2}">You scanned #8813. That&#39;s for <b style="color: {INK}">stop 15, 1310 Kenwood Ave</b>, next door.</span></div>
<div style="font-size: 14px; font-weight: 600; margin-top: 4px">Grab this one instead:</div>
{boxcard("14","#8812","12-pack")}
<div style="font-size: 13px; line-height: 19px; color: {T2}">The app won&#39;t mark this stop delivered until the right box is scanned here. Each box&#39;s bottles were already checked at the micro-factory.</div>
<div style="margin-top: auto; display: flex; flex-direction: column; gap: 10px">{big("Scan the right box","DriverDoor.dc.html")}{big("Box missing or damaged","#",False,48)}</div>'''
page('DriverWrong','D3.2 Wrong box',body)

c=json.load(open(P+'canvas.json'))
for i,(n,t) in enumerate([('DriverLoad','D2 · Load the van'),('DriverNext','D3 · Next stop'),('DriverDoor','D3.1 · At the door'),('DriverWrong','D3.2 · Wrong box')]):
    c['boards'][n+'.dc.html']={"x":i*470,"y":8400,"w":390,"h":844,"title":t,"is_interactive":True}
    if n+'.dc.html' not in c['order']: c['order'].append(n+'.dc.html')
c['notes']['step3d']={"x":0,"y":8100,"text":"Step 3 · Wireframes: driver app","kind":"title1","maxW":1800}
json.dump(c,open(P+'canvas.json','w'),indent=2)
