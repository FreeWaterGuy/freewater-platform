import sys,json,os
P=sys.argv[1]
_D=os.path.dirname(os.path.abspath(__file__))
__file__=_D+'/ops.py'
exec(open(__file__).read())
DNAV=[("Docs","DevDocs"),("Apps and keys",None),("Sandbox","DevSandbox"),("Submit","DevSubmit"),("Marketplace","DevMarket")]
def dpage(fname,title,active,body):
    links=''.join(f'<a href="{(f+".dc.html") if f else "#"}" style="font-size: 14px; text-decoration: none; {"font-weight: 600; border-bottom: 2px solid "+INK+"; padding-bottom: 4px" if n==active else "color: "+T2}">{n}</a>' for n,f in DNAV)
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
<div style="width: 1440px; height: 900px; box-sizing: border-box; background: #ffffff; font-family: 'IBM Plex Sans', 'Helvetica Neue', sans-serif; color: {INK}; display: flex; flex-direction: column">
<div style="display: flex; align-items: center; justify-content: space-between; padding: 18px 40px; border-bottom: 1px solid {B}"><div style="display: flex; align-items: baseline; gap: 10px"><span style="font-size: 20px; font-weight: 600">freewater</span><span style="{MONO}; font-size: 11px; letter-spacing: 0.12em; color: {T2}">DEVELOPERS</span></div><div style="display: flex; gap: 28px; align-items: center">{links}<span style="width: 260px; height: 36px; border: 1px solid {B}; border-radius: 18px; display: flex; align-items: center; padding: 0 14px; font-size: 13px; color: {T3}">Search docs or ask a question</span></div></div>
<div style="flex: 1 1 auto; display: flex; min-height: 0">{body}</div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":900}}}}'>
class Component extends DCLogic {{
renderVals() {{
return {{}};
}}
}}
</script>
</body>
</html>
'''
    open(P+fname+'.dc.html','w').write(html)
def code(lines):
    body='<br>'.join(lines)
    return f'<div style="background: {INK}; color: #e6e9ef; border-radius: 12px; padding: 16px 18px; {MONO}; font-size: 13px; line-height: 21px; white-space: nowrap; overflow: hidden">{body}</div>'
C=lambda t: f'<span style="color: {T3}">{t}</span>'

def field(a,b,note=''):
    return f'<div style="display: flex; flex-direction: column; gap: 4px"><span style="font-size: 13px; font-weight: 600">{a}</span><span style="height: 40px; border: 1px solid {B}; border-radius: 10px; display: flex; align-items: center; padding: 0 12px; font-size: 14px">{b}</span></div>'

# P1 Docs
groups=[("START",["Overview","How the platform fits together","Your first plug-in"]),("CONTRACTS",["Experience plug-in","Ad source","Print adapter","Machine driver","Payments adapter","Route planner","AI model adapter"]),("REFERENCE",["Events catalog","Public API","Webhooks","Billing rules"])]
nav=''.join(f'<div style="{MONO}; font-size: 10px; letter-spacing: 0.12em; color: {T2}; padding: 14px 12px 4px">{g}</div>'+''.join(f'<a href="#" style="display: block; padding: 6px 12px; border-radius: 6px; font-size: 14px; text-decoration: none; {"background: "+G1+"; font-weight: 600" if i=="Experience plug-in" else "color: "+T2}">{i}</a>' for i in items) for g,items in groups)
snippet=code([
 C("// what a scan or AR launch opens"),
 "export default definePlugin({",
 "&nbsp;&nbsp;name: &quot;3d-menu&quot;,",
 "&nbsp;&nbsp;async resolve(scan, ctx) {",
 "&nbsp;&nbsp;&nbsp;&nbsp;"+C("// scan = unit, slot, owner, device, place, time"),
 "&nbsp;&nbsp;&nbsp;&nbsp;"+C("// scan.viewer only if they said yes to sharing"),
 "&nbsp;&nbsp;&nbsp;&nbsp;return ctx.ar.model({ src: &quot;combo.glb&quot;, cta: &quot;Order now&quot; })",
 "&nbsp;&nbsp;},",
 "&nbsp;&nbsp;onEngage(event, ctx) {",
 "&nbsp;&nbsp;&nbsp;&nbsp;ctx.report(event) "+C("// viewed, ar_launched, tapped, purchased"),
 "&nbsp;&nbsp;}",
 "})"])
rules=''.join(f'<div style="display: flex; gap: 10px; font-size: 14px; line-height: 20px; border-top: 1px solid {G1}; padding-top: 8px"><span style="{MONO}; font-size: 12px; color: {T2}; width: 18px">{i+1}</span><span>{t}</span></div>' for i,t in enumerate(["Answer in under 300 ms, or the platform shows the owner&#39;s fallback.","Work for someone who shared nothing. Personal data is optional, never required.","Report each engagement once, with its idempotency key. The platform bills it.","An AR launch only counts if it loads. Report failures; they are never billed.","Never store data outside what the contract hands you."]))
body=f'''<div style="width: 250px; flex: none; border-right: 1px solid {B}; padding: 10px 14px; box-sizing: border-box">{nav}</div>
<div style="flex: 1 1 auto; padding: 28px 40px; display: flex; flex-direction: column; gap: 16px; min-width: 0">
<div style="font-size: 13px; color: {T2}">Contracts / Experience plug-in · v1.4</div>
<div style="font-size: 30px; font-weight: 600">Experience plug-in</div>
<div style="font-size: 15px; line-height: 22px; color: {T2}; max-width: 760px">Decides what a scan or AR launch opens. Offers, 3D menus, home tours, games and AI salespeople are all plug-ins of this one shape, so anyone can add new ones forever.</div>
{snippet}
<div style="font-size: 17px; font-weight: 600; margin-top: 4px">The rules every plug-in follows</div>
<div style="display: flex; flex-direction: column; gap: 8px; max-width: 820px">{rules}</div>
</div>
<div style="width: 300px; flex: none; padding: 28px 32px 28px 0; display: flex; flex-direction: column; gap: 14px">
{card(lab("TRY IT NOW")+'<div style="font-size: 14px; line-height: 20px">Run this plug-in on a virtual Model 6 and scan the bottle it prints.</div>'+btn("Open sandbox","DevSandbox.dc.html",True,40))}
{card(lab("EVENTS IT GETS")+''.join(f'<div style="{MONO}; font-size: 12px; padding: 3px 0">{e}</div>' for e in ["unit.scanned","experience.engaged","order.created","order.refunded"]))}
{card(lab("ASK")+'<div style="font-size: 13px; color: '+T2+'">&quot;How do I show a different offer to first-time scanners?&quot;</div>')}
</div>'''
dpage('DevDocs','P1 Docs','Docs',body)

# P3 Sandbox
evs=''.join(f'<div style="display: flex; gap: 12px; font-size: 12px; {MONO}; padding: 5px 0; border-bottom: 1px solid #39415a"><span style="color: {T3}; width: 64px; flex: none">{t}</span><span style="width: 150px; flex: none; color: #fff">{e}</span><span style="color: {T3}">{d}</span></div>' for t,e,d in [("00:00.0","order.created","test user · one tap"),("00:00.4","label.rendered","3 slots · your plug-in in slot 2"),("00:01.1","label.printed","virtual printer · confirmed"),("00:24.0","unit.dispensed","tray"),("00:31.2","unit.scanned","slot 2 → 3d-menu"),("00:31.4","experience.resolved","212 ms ✓"),("00:33.0","experience.engaged","ar_launched · would bill 1 AR launch")])
btns=''.join(f'<a href="#" style="height: 40px; border-radius: 20px; {"background: "+INK+"; color: #fff" if i==3 else "border: 1px solid "+B}; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; text-decoration: none">{x}</a>' for i,x in enumerate(["Order a bottle","Print","Dispense","Scan slot 2","Launch AR","Buy something","Fail the AR","Refund"]))
body=f'''<div style="flex: 1 1 auto; padding: 24px 40px; display: flex; flex-direction: column; gap: 16px; min-width: 0">
<div style="display: flex; justify-content: space-between; align-items: center"><div style="display: flex; flex-direction: column"><div style="font-size: 24px; font-weight: 600">Sandbox</div><div style="font-size: 14px; color: {T2}">Fake machines, a virtual printer and test money. Nothing here is real or billed.</div></div><div style="display: flex; gap: 8px">{chip("Virtual Model 6",True)}{chip("Micro-factory line")}{chip("12-pack route")}</div></div>
<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
<div style="width: 300px; flex: none; display: flex; flex-direction: column; gap: 12px">
{card(lab("DRIVE THE MACHINE")+f'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">{btns}</div>')}
{card(lab("TEST VIEWER")+f'<div style="display: flex; gap: 6px; flex-wrap: wrap">{chip("First-time",True)}{chip("Regular")}{chip("Shared nothing")}{chip("Passed-along bottle")}</div>')}
</div>
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 12px; min-width: 0">
{ph("230px","VIRTUAL PRINTER · THE LABEL IT JUST PRINTED, FLAT")}
<div style="flex: 1 1 auto; background: {INK}; border-radius: 12px; padding: 14px 18px; display: flex; flex-direction: column; min-height: 0"><div style="{MONO}; font-size: 11px; letter-spacing: 0.12em; color: {T3}; padding-bottom: 6px">EVENT STREAM</div>{evs}</div>
</div>
<div style="width: 280px; flex: none; display: flex; flex-direction: column; gap: 10px; align-items: center">
{lab("WHAT THE PHONE SHOWS")}
<div style="width: 260px; flex: 1 1 auto; border: 2px solid {INK}; border-radius: 32px; padding: 18px 14px; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px">{ph("100%","YOUR PLUG-IN · LIVE")}</div>
{card(lab("WOULD BILL")+f'<div style="font-size: 13px">1 print · 1 scan · 1 AR launch</div>',"; width: 100%; box-sizing: border-box")}
</div></div></div>'''
dpage('DevSandbox','P3 Sandbox','Sandbox',body)

# P4 Submit
tests=''.join(f'<div style="display: flex; justify-content: space-between; align-items: center; font-size: 14px; border-top: 1px solid {G1}; padding-top: 8px"><span>{a}</span><span style="font-size: 13px; {"font-weight: 600" if b.startswith("✗") else "color: "+T2}">{b}</span></div>' for a,b in [("Answers in under 300 ms","✓ 212 ms average"),("Works for a viewer who shared nothing","✓"),("Reports each engagement exactly once","✓ retries tested"),("Failed AR is reported and not billed","✓"),("Keeps no data outside the contract","✓"),("Works on old phones","✗ iOS 15 fails to load the model"),("Accessible: labels, contrast, captions","✓")])
body=f'''<div style="flex: 1 1 auto; padding: 24px 40px; display: flex; gap: 24px; min-width: 0">
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 16px; min-width: 0">
<div style="display: flex; flex-direction: column"><div style="font-size: 24px; font-weight: 600">Submit 3d-menu v1.0</div><div style="font-size: 14px; color: {T2}">Contract tests run automatically. People review anything that passes.</div></div>
{card(f'<div style="display: flex; justify-content: space-between">{lab("CONTRACT TESTS · 6 OF 7 PASS")}<a href="#" style="font-size: 13px; font-weight: 600">Run again</a></div>'+tests)}
{card(lab("HOW TO FIX THE FAILURE")+'<div style="font-size: 14px; line-height: 20px">The .glb model uses a compression older iPhones can&#39;t open. Add a fallback model, or set the minimum version in your listing.</div>')}
</div>
<div style="width: 400px; flex: none; display: flex; flex-direction: column; gap: 14px">
{card(lab("LISTING")+field("Name","3D Menu in AR")+field("Who it&#39;s for","Restaurants, food trucks")+field("Price to install","Free · or set a price"))}
{card(lab("REVENUE SHARE")+'<div style="font-size: 14px; line-height: 20px">You earn a share of the scan and AR fees your plug-in creates. The share is set per company, shown here before you submit.</div>')}
<div style="display: flex; flex-direction: column; gap: 6px">{btn("Submit for review","#",True,48)}<span style="font-size: 12px; color: {T2}; text-align: center">Disabled until all tests pass</span></div>
</div></div>'''
dpage('DevSubmit','P4 Submit a plug-in','Submit',body)

# P5 Marketplace
items=[("3D Menu in AR","Experience plug-in","restaurants","1,240 installs"),("Home Tour","Experience plug-in","real estate","610 installs"),("AI Salesperson","Experience plug-in","any business","2,080 installs"),("Breaking News Card","Experience plug-in","publishers","430 installs"),("Scratch-off Coupon","Experience plug-in","retail","980 installs"),("Birthday Template","Custom design template","consumers","5,400 uses"),("Adyen Payments","Adapter","licensees","38 companies"),("Industrial Label Printer","Print adapter","machines and factories","21 companies")]
cards=''.join(f'<a href="#" style="border: 1px solid {B}; border-radius: 14px; overflow: hidden; display: flex; flex-direction: column; text-decoration: none"><div style="height: 120px; background: {G2}; border-bottom: 1px solid {B}"></div><div style="padding: 12px 14px; display: flex; flex-direction: column; gap: 3px"><span style="{MONO}; font-size: 10px; letter-spacing: 0.1em; color: {T2}">{b.upper()}</span><span style="font-size: 15px; font-weight: 600">{a}</span><span style="font-size: 12px; color: {T2}">For {c} · {d}</span></div></a>' for a,b,c,d in items)
body=f'''<div style="flex: 1 1 auto; padding: 24px 40px; display: flex; flex-direction: column; gap: 16px; min-width: 0">
<div style="display: flex; justify-content: space-between; align-items: flex-end"><div style="display: flex; flex-direction: column; gap: 4px"><div style="font-size: 28px; font-weight: 600">Marketplace</div><div style="font-size: 14px; color: {T2}">Plug-ins, templates and adapters. Install one and it works on every bottle, pack and machine.</div></div>{btn("Submit yours","DevSubmit.dc.html",False,40)}</div>
<div style="display: flex; gap: 8px">{chip("All",True)}{chip("Experience plug-ins")}{chip("Design templates")}{chip("Ad sources")}{chip("Printers and machines")}{chip("Payments")}{chip("Routing")}{chip("AI models")}</div>
<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px">{cards}</div>
</div>'''
dpage('DevMarket','P5 Marketplace','Marketplace',body)

c=json.load(open(P+'canvas.json'))
for i,(n,t) in enumerate([('DevDocs','P1 · Docs'),('DevSandbox','P3 · Sandbox'),('DevSubmit','P4 · Submit a plug-in'),('DevMarket','P5 · Marketplace')]):
    c['boards'][n+'.dc.html']={"x":i*1520,"y":12900,"w":1440,"h":900,"title":t,"is_interactive":True}
    if n+'.dc.html' not in c['order']: c['order'].append(n+'.dc.html')
c['notes']['step3g']={"x":0,"y":12600,"text":"Step 3 · Wireframes: developer portal","kind":"title1","maxW":5960}
json.dump(c,open(P+'canvas.json','w'),indent=2)
