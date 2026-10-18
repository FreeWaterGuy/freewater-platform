import sys,json
P=sys.argv[1]
exec(open(__file__.replace('ops.py','adv.py')).read())
NAV=[('Live map','OpsMap'),('Machines','OpsMachine'),('Print queue','OpsQueue'),('Micro-factory lines','OpsLines'),('Packs','OpsPacks'),('Routes','OpsRoutes'),('Content review','OpsReview'),('Ledger admin','OpsLedger'),('Support','OpsSupport')]
def shell(fname,title,active,right_hdr,body):
    side=''.join(f'<a href="{(f+".dc.html") if f else "#"}" style="padding: 8px 12px; border-radius: 8px; font-size: 14px; text-decoration: none; {"background: "+G1+"; font-weight: 600" if n==active else "color: "+T2}">{n}</a>' for n,f in NAV)
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
<div style="width: 1440px; height: 900px; box-sizing: border-box; background: #ffffff; font-family: 'IBM Plex Sans', 'Helvetica Neue', sans-serif; color: {INK}; display: flex">
<div style="width: 220px; flex: none; border-right: 1px solid {B}; padding: 22px 14px; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px">
<div style="font-size: 20px; font-weight: 600; padding: 0 12px 4px">freewater</div>
<div style="{MONO}; font-size: 10px; letter-spacing: 0.12em; color: {T2}; padding: 0 12px 16px">OPERATIONS</div>
{side}
<div style="margin-top: auto; display: flex; flex-direction: column; gap: 2px; padding: 0 12px"><span style="font-size: 13px; font-weight: 600">Austin, TX</span><span style="font-size: 12px; color: {T2}">Switch city or company</span></div>
</div>
<div style="flex: 1 1 auto; min-width: 0; padding: 20px 32px 24px; display: flex; flex-direction: column; gap: 14px; box-sizing: border-box">
<div style="display: flex; justify-content: space-between; align-items: center; gap: 16px"><div style="font-size: 22px; font-weight: 600; white-space: nowrap">{title}</div><div style="display: flex; align-items: center; gap: 8px">{right_hdr}</div></div>
{body}
</div>
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
def tiles(items):
    return '<div style="display: flex; gap: 12px">'+''.join(f'<div style="flex: 1 1 0; background: {G2}; border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px"><div style="font-size: 12px; color: {T2}">{a}</div><div style="font-size: 24px; font-weight: 600">{b}</div><div style="font-size: 12px; color: {T2}">{c}</div></div>' for a,b,c in items)+'</div>'
def badge(t,dark=False,dashed=False):
    s=f'background: {INK}; color: #ffffff' if dark else f'border: 1px {"dashed" if dashed else "solid"} {B}'
    return f'<span style="font-size: 12px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; {s}">{t}</span>'
def alert(level,t,s,act,href='#'):
    return f'<div style="display: flex; gap: 10px; border-top: 1px solid {G1}; padding-top: 10px"><span style="width: 8px; height: 8px; border-radius: 4px; margin-top: 6px; flex: none; background: {INK if level else T3}"></span><span style="display: flex; flex-direction: column; flex: 1 1 auto; gap: 2px"><span style="font-size: 14px; font-weight: 600">{t}</span><span style="font-size: 12px; color: {T2}">{s}</span></span><a href="{href}" style="font-size: 13px; font-weight: 600; white-space: nowrap">{act}</a></div>'
def table(heads,rows,align=None,bold0=True):
    align=align or ['left']*len(heads)
    th=''.join(f'<th style="text-align: {align[i]}; font-size: 12px; font-weight: 600; color: {T2}; padding: 8px 10px; border-bottom: 1px solid {B}; white-space: nowrap">{h}</th>' for i,h in enumerate(heads))
    tr=''.join('<tr>'+''.join(f'<td style="text-align: {align[i]}; font-size: 13px; padding: 8px 10px; border-bottom: 1px solid {G1}; {"font-weight: 600; " if i==0 and bold0 else ""}{MONO+"; font-size: 12px; " if i==0 else ""}">{c}</td>' for i,c in enumerate(r))+'</tr>' for r in rows)
    return f'<table style="border-collapse: collapse; width: 100%"><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table>'

# O1 Live map
hdr=chip("Machines",True)+chip("Micro-factory",True)+chip("Vans",True)+chip("Alerts only")
body=f'''{askbar("e.g. &quot;Which machines will run out of labels before tonight?&quot;")}
{tiles([("Bottles printed today","3,912","1,204 scanned"),("Packs delivered","214 / 260","4 routes running"),("Failed prints","6","0.15% · none billed"),("Machines online","41 / 42","1 restocking"),("Content to review","9","oldest 3 h")])}
<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
<div style="position: relative; flex: 1 1 auto; border-radius: 12px; border: 1px solid {B}; background: {G2}; overflow: hidden">
<svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" style="position: absolute; inset: 0; width: 100%; height: 100%"><line x1="0" y1="0" x2="100" y2="100" stroke="#d3d8e0" stroke-width="0.6" vector-effect="non-scaling-stroke"/><line x1="100" y1="0" x2="0" y2="100" stroke="#d3d8e0" stroke-width="0.6" vector-effect="non-scaling-stroke"/><polyline points="20,70 35,55 52,58 66,40 80,32" fill="none" stroke="{T3}" stroke-width="1.5" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/></svg>
<a href="OpsMachine.dc.html" style="position: absolute; left: 44%; top: 46%; width: 26px; height: 26px; border-radius: 13px; background: {INK}; border: 3px solid #fff; box-sizing: border-box"></a>
<span style="position: absolute; left: 46%; top: 51%; font-size: 12px; font-weight: 600; background: #fff; padding: 2px 6px; border-radius: 6px">ATX-014</span>
<span style="position: absolute; left: 24%; top: 30%; width: 22px; height: 22px; border-radius: 11px; background: {T3}; border: 3px solid #fff"></span>
<span style="position: absolute; left: 70%; top: 62%; width: 22px; height: 22px; border-radius: 11px; background: #fff; border: 3px dashed {T3}"></span>
<span style="position: absolute; left: 64%; top: 37%; width: 30px; height: 20px; border-radius: 5px; background: {INK}; border: 2px solid #fff"></span>
<span style="position: absolute; left: 12%; top: 66%; width: 34px; height: 34px; border-radius: 6px; background: {G1}; border: 2px solid {INK}"></span>
<div style="position: absolute; left: 12px; bottom: 12px; display: flex; gap: 14px; background: #fff; padding: 6px 10px; border-radius: 8px; font-size: 12px; color: {T2}"><span>● machine</span><span>■ van on route</span><span>□ micro-factory</span><span>◌ restocking</span></div>
<div style="position: absolute; left: 12px; top: 12px; {MONO}; font-size: 11px; color: {T2}; background: #fff; padding: 3px 8px; border-radius: 6px">LIVE MAP · AUSTIN</div>
</div>
<div style="width: 400px; flex: none; display: flex; flex-direction: column; gap: 12px">
{card(f'<div style="display: flex; justify-content: space-between">{lab("NEEDS ATTENTION · 4")}<a href="#" style="font-size: 13px; font-weight: 600">All</a></div>'+alert(1,"ATX-031 label roll at 4%","East 6th · runs out in ≈ 40 bottles","Send restock")+alert(1,"ATX-022 printer jam","Auto-retried; 1 print failed, not billed","Open","OpsMachine.dc.html")+alert(0,"Van 2 running 12 min late","Route 7 · Mueller · 18 stops left","Message driver")+alert(0,"Pack #8812 mismatch","Line B · 1 bottle QR didn&#39;t match the pack list","Reprint bottle","OpsQueue.dc.html"))}
{card(lab("MICRO-FACTORY · EAST AUSTIN")+'<div style="display: flex; justify-content: space-between; font-size: 14px"><span style="color: '+T2+'">Tonight&#39;s packs</span><span style="font-weight: 600">212 of 260 printed</span></div><div style="height: 8px; border-radius: 4px; background: '+G1+'"><div style="width: 82%; height: 8px; border-radius: 4px; background: '+INK+'"></div></div><div style="font-size: 12px; color: '+T2+'">Line A running · Line B paused for the mismatch</div>')}
</div></div>'''
shell('OpsMap','Live map','Live map',hdr,body)

# O2.1 Machine detail
hdr=badge("Online",True)+btn("Pause ordering","#",False,40)+btn("Print a test label","#",True,40)
log=''.join(f'<div style="display: flex; gap: 12px; font-size: 12px; {MONO}; padding: 5px 0; border-bottom: 1px solid {G1}"><span style="color: {T2}; width: 64px; flex: none">{t}</span><span style="width: 150px; flex: none; font-weight: 600">{e}</span><span style="color: {T2}">{d}</span></div>' for t,e,d in [("14:02:11","unit.scanned","u_7f3a · slot 2 · Joe&#39;s Burgers · AR launched"),("14:01:56","unit.dispensed","u_91c0 · picked up from tray"),("14:01:31","label.printed","u_91c0 · 3 ads · confirmed"),("14:01:24","label.rendered","u_91c0 · 412 ms"),("14:01:22","order.created","app user · one tap"),("13:58:40","print.failed","u_88d2 · head jam · auto-retry OK · not billed"),("13:58:02","unit.scanned","u_6b11 · slot 1 · Austin Daily · news"),("13:55:47","label.printed","u_70e4 · custom design · paid")])
def gauge(a,v,w,note=''):
    notehtml=f'<div style="font-size: 11px; color: {T2}">{note}</div>' if note else ''
    return f'<div style="display: flex; flex-direction: column; gap: 4px"><div style="display: flex; justify-content: space-between; font-size: 13px"><span style="color: {T2}">{a}</span><span style="font-weight: 600">{v}</span></div><div style="height: 8px; border-radius: 4px; background: {G1}"><div style="width: {w}%; height: 8px; border-radius: 4px; background: {INK}"></div></div>{notehtml}</div>'
body=f'''<div style="font-size: 14px; color: {T2}; margin-top: -8px">ATX-014 · 600 Congress Ave · outdoor · Model 6 · gives to Austin Parks Foundation</div>
{tiles([("Bottles in stock","252 / 350","restock in ≈ 2 days"),("Printed today","188","2 paid custom designs"),("Scan rate","31%","58 scans today"),("Print failures","1","none billed"),("Uptime, 30 days","99.6%","last service Oct 2")])}
<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
{card(f'<div style="display: flex; justify-content: space-between">{lab("LIVE LOG · EVERY EVENT")}<a href="#" style="font-size: 13px; font-weight: 600">Filter</a></div><div style="display: flex; flex-direction: column">{log}</div>',"; flex: 1 1 auto; min-width: 0")}
<div style="width: 400px; flex: none; display: flex; flex-direction: column; gap: 12px">
{card(lab("SUPPLIES")+gauge("Label roll","61%",61,"≈ 840 labels left")+gauge("Ink · lowest is cyan","38%",38)+gauge("Caps","74%",74))}
{ph("150px","CAMERA · TRAY AND SCREEN")}
{card(lab("REMOTE ACTIONS")+'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">'+''.join(f'<a href="#" style="height: 38px; border-radius: 19px; border: 1px solid {B}; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; text-decoration: none">{x}</a>' for x in ["Restart printer","Clean print head","Message on screen","Schedule restock"])+'</div>')}
</div></div>'''
shell('OpsMachine','Machine ATX-014','Machines',hdr,body)

# O3 Print queue
hdr=chip("All",True)+chip("Machines")+chip("Micro-factory")+chip("Failed · 6")
rows=[("j_5521","ATX-014","1 bottle","3 ads",badge("Printing",True),"now"),
("j_5520","Line A","12-pack · Route 3","66 ads + 5 box faces",badge("Rendering"),"12 s"),
("j_5519","ATX-022","1 bottle","Custom design",badge("Printed"),"40 s"),
("j_5517","Line B","Pack #8812","1 bottle mismatch",badge("Failed",dashed=True),"3 min"),
("j_5514","ATX-031","1 bottle","2 ads",badge("Queued"),"waiting for labels"),
("j_5509","Line A","24-pack · Route 7","118 ads + 5 box faces",badge("Printed"),"6 min"),
("j_5502","ATX-022","1 bottle","4 ads",badge("Failed",dashed=True),"9 min")]
body=f'''{askbar("e.g. &quot;Why did ATX-022 fail twice today?&quot;")}
{tiles([("In queue","38","median wait 3 s"),("Printing now","7","5 machines, 2 lines"),("Printed today","4,218","bottles and box faces"),("Failed today","6","0.15% · none billed"),("Reprinted","5 of 6","1 waiting on labels")])}
<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
{card(lab("JOBS")+table(["Job","Where","What","Content","Status","Age"],rows),"; flex: 1 1 auto; min-width: 0")}
<div style="width: 400px; flex: none">{card(lab("FAILED JOB j_5517")+'<div style="font-size: 16px; font-weight: 600">Pack #8812 · bottle 7 of 12</div><div style="font-size: 13px; line-height: 19px; color: '+T2+'">The QR on bottle 7 didn&#39;t match the pack list during verification. The pack was held before sealing.</div>'+''.join(f'<div style="display: flex; justify-content: space-between; font-size: 13px; border-top: 1px solid {G1}; padding-top: 8px"><span style="color: {T2}">{a}</span><span style="font-weight: 600">{b}</span></div>' for a,b in [("Advertisers billed","No, failures are never billed"),("Customer impact","None yet · packs ship 6 am"),("Likely cause","Label applied out of order")])+'<div style="display: flex; gap: 8px; margin-top: 4px">'+btn("Reprint bottle 7","#",True,40)+btn("Reprint whole pack","#",False,40)+'</div>',"; height: 100%; box-sizing: border-box")}</div>
</div>'''
shell('OpsQueue','Print queue','Print queue',hdr,body)

# O7 Content review
q=''.join(f'<a href="#" style="display: flex; gap: 10px; padding: 10px; border-radius: 10px; text-decoration: none; {"background: "+G1 if i==0 else ""}"><span style="width: 40px; height: 40px; flex: none; border-radius: 8px; background: {G1 if i else "#fff"}; border: 1px solid {B}"></span><span style="display: flex; flex-direction: column; gap: 2px; min-width: 0"><span style="font-size: 14px; font-weight: 600">{a}</span><span style="font-size: 12px; color: {T2}">{b}</span></span></a>' for i,(a,b) in enumerate([("Fall menu","Ad · Joe&#39;s Burgers · 3 h"),("Rail line opens","Ad · Austin Daily · 2 h"),("Open house Sat","Ad · Maple Realty · 1 h"),("Maya&#39;s 30th","Custom bottle · consumer · 40 min"),("Team bottles","Custom 24-pack · 20 min")]))
checks=''.join(f'<div style="display: flex; justify-content: space-between; font-size: 13px; border-top: 1px solid {G1}; padding-top: 8px"><span>{a}</span><span style="color: {T2}">{b}</span></div>' for a,b in [("Prohibited content","✓ none"),("Claims and prices","⚠ &quot;Best in Austin&quot; needs support"),("Print quality, all sizes","✓ OK"),("QR leads to a safe page","✓ OK"),("AR experience loads","✓ 1.2 s"),("Ad rules for this company","✓ OK")])
hdr=chip("All · 9",True)+chip("Ads · 6")+chip("Custom bottles · 3")
body=f'''<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
<div style="width: 280px; flex: none; display: flex; flex-direction: column; gap: 4px">{lab("QUEUE · OLDEST FIRST")}{q}</div>
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 12px; min-width: 0">
<div style="display: flex; gap: 8px">{chip("On a bottle",True)}{chip("All 6 sizes")}{chip("Box face")}{chip("Scan page")}{chip("AR")}</div>
{ph("100%","FALL MENU · ON A BOTTLE NEXT TO OTHER ADS","; flex: 1 1 auto")}
</div>
<div style="width: 360px; flex: none; display: flex; flex-direction: column; gap: 12px">
{card(lab("AI PRE-CHECK")+'<div style="font-size: 14px; line-height: 20px">Looks fine except one claim. "Best burger in Austin" is a superlative without support. Suggest "Austin&#39;s favorite $5 combo" or ask for proof.</div>'+checks)}
{card(lab("DECISION")+'<div style="display: flex; flex-direction: column; gap: 8px">'+btn("Approve","#",True,42)+btn("Ask for a change","#",False,42)+'<a href="#" style="text-align: center; font-size: 13px; font-weight: 600">Reject with a reason</a></div><div style="font-size: 12px; color: '+T2+'">Every decision is logged with who made it and why.</div>')}
</div></div>'''
shell('OpsReview','Content review','Content review',hdr,body)


# O4 Micro-factory lines
def station(n,t,sub,state):
    st={'ok':f'border: 1px solid {B}','warn':f'border: 2px solid {INK}','idle':f'border: 1px dashed {B}'}[state]
    return f'<div style="flex: 1 1 0; min-width: 0; {st}; border-radius: 12px; padding: 10px; display: flex; flex-direction: column; gap: 4px; background: {"#fff" if state!="idle" else G2}"><span style="{MONO}; font-size: 10px; color: {T2}">{n}</span><span style="font-size: 13px; font-weight: 600; line-height: 17px">{t}</span><span style="font-size: 11px; color: {T2}; line-height: 15px">{sub}</span></div>'
arrow=f'<span style="flex: none; align-self: center; color: {T3}">→</span>'
stations=[("1","Bottles in","1,400 / h","ok"),("2","Print labels","3 printers · 412 ms","ok"),("3","Apply labels","1,380 / h","ok"),("4","Cap and check","ok","ok"),("5","Scan and verify","1 mismatch","warn"),("6","Group into packs","pack #8813","ok"),("7","Print box faces","5 faces per box","ok"),("8","Seal","ok","ok"),("9","Load bay","by route, reversed","idle")]
flow=arrow.join(station(*x) for x in stations)
def cell(i,state):
    st={'ok':f'background: {INK}; color: #fff','now':f'border: 2px solid {INK}','bad':f'border: 2px dashed {INK}','wait':f'border: 1px solid {B}; color: {T2}'}[state]
    lbl={'ok':'✓','now':'printing','bad':'✗ QR','wait':'waiting'}[state]
    return f'<div style="height: 64px; border-radius: 10px; {st}; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; font-size: 12px"><span style="{MONO}; font-size: 10px; opacity: .8">{i}</span><span style="font-weight: 600">{lbl}</span></div>'
grid=''.join(cell(i+1,'ok' if i<6 else 'bad' if i==6 else 'now' if i==7 else 'wait') for i in range(12))
hdr=chip("Line A · running",True)+chip("Line B · paused")+btn("Pause line","#",False,40)
body=f"""{askbar("e.g. &quot;Will we finish tonight&#39;s packs before the 6 am vans?&quot;")}
{tiles([("Tonight&#39;s packs","212 / 260","Line A 140 · Line B 72"),("Bottles per hour","1,400","target 1,500"),("Verified first time","99.8%","1 mismatch tonight"),("Done by","4:40 am","vans leave 6:00 am"),("Labels and ink","OK","next roll change ≈ 2 h")])}
{card(lab("LINE A · STATION BY STATION")+f'<div style="display: flex; gap: 6px">{flow}</div>')}
<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
{card(f'<div style="display: flex; justify-content: space-between">{lab("PACK BEING BUILT · #8812 · 12-PACK · ROUTE 3 STOP 14")}<a href="OpsPacks.dc.html" style="font-size: 13px; font-weight: 600">Open pack</a></div><div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px">{grid}</div><div style="font-size: 13px; color: {T2}">Bottle 7&#39;s QR didn&#39;t match. It is pulled and reprinted automatically; the pack waits, then seals.</div>',"; flex: 1 1 auto; min-width: 0")}
<div style="width: 360px; flex: none; display: flex; flex-direction: column; gap: 12px">{ph("100%","CAMERA · STATION 5 VERIFY","; flex: 1 1 auto")}</div>
</div>"""
shell('OpsLines','Micro-factory · East Austin','Micro-factory lines',hdr,body)

# O5 Packs
rows=[("#8812","12","Route 3 · stop 14","11 / 12",badge("Mismatch",dashed=True)),("#8813","12","Route 3 · stop 15","12 / 12",badge("Sealed",True)),("#8814","24","Route 7 · stop 2","9 / 24",badge("Printing")),("#8815","6","Route 3 · stop 16","6 / 6",badge("Loaded",True)),("#8816","12","Route 1 · stop 4","0 / 12",badge("Composed")),("#8817","24","Route 7 · stop 3","24 / 24",badge("Sealed",True)),("#8818","6","Route 1 · stop 5","0 / 6",badge("Composed"))]
mini=''.join(f'<div style="height: 46px; border-radius: 8px; {"border: 2px dashed "+INK if i==6 else "background: "+G2}; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 11px"><span style="{MONO}; font-size: 9px; color: {T2}">{i+1}</span><span style="font-weight: 600">{a}</span></div>' for i,a in enumerate(["3 ads","2 ads","5 ads","1 ad","4 ads","3 ads","✗ QR","6 ads","2 ads","3 ads","4 ads","1 ad"]))
faces=''.join(f'<div style="display: flex; justify-content: space-between; font-size: 13px; border-top: 1px solid {G1}; padding-top: 6px"><span style="color: {T2}">{a}</span><span style="font-weight: 600">{b}</span></div>' for a,b in [("Top","Joe&#39;s Burgers"),("Front","Maple Realty"),("Back","Austin Daily"),("Left","FreeWater panel · facts, receipt QR"),("Right","H-E-B"),("Bottom","Blank")])
hdr=chip("Tonight · 260",True)+chip("Mismatch · 1")+chip("6-packs")+chip("12-packs")+chip("24-packs")
body=f"""{askbar("e.g. &quot;Which packs for Route 7 aren&#39;t sealed yet?&quot;")}
<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
{card(lab("PACKS FOR TOMORROW&#39;S DELIVERIES")+table(["Pack","Size","Goes to","Bottles verified","Status"],rows),"; flex: 1 1 auto; min-width: 0")}
<div style="width: 440px; flex: none; display: flex; flex-direction: column; gap: 12px">
{card(f'<div style="display: flex; justify-content: space-between; align-items: baseline"><span style="font-size: 17px; font-weight: 600">Pack #8812 · 12-pack</span><span style="font-size: 13px; color: {T2}">Route 3 · stop 14</span></div><div style="font-size: 13px; color: {T2}">Every bottle different, printed for this home. 34 ads from 19 advertisers.</div><div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px">{mini}</div>')}
{card(lab("BOX FACES · ALL ADS EXCEPT THE FREEWATER PANEL")+faces)}
{card(f'<div style="font-size: 13px; color: {T2}">Bottle 7 reprint queued. Pack seals when all 12 QRs match.</div><div style="display: flex; gap: 8px">{btn("Reprint bottle 7","OpsQueue.dc.html",True,40)}{btn("Reprint pack","#",False,40)}</div>')}
</div></div>"""
shell('OpsPacks','Packs','Packs',hdr,body)

# O6 Routes
rl=''.join(f'<a href="#" style="display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: 10px; text-decoration: none; {"background: "+G1 if i==0 else "border: 1px solid "+G1}"><span style="display: flex; justify-content: space-between"><span style="font-size: 14px; font-weight: 600">{a}</span>{badge(e,i<2)}</span><span style="font-size: 12px; color: {T2}">{b}</span><span style="font-size: 12px; color: {T2}">{c} · {d}</span></a>' for i,(a,b,c,d,e) in enumerate([("Route 3 · Travis Heights","Van 1 · Dana R.","42 stops, 46 packs","31 empties to pick up","Loading"),("Route 7 · Mueller","Van 2 · Luis M.","38 stops, 41 packs","27 empties","Loading"),("Route 1 · Hyde Park","Van 3 · not assigned","35 stops, 38 packs","22 empties","Planned"),("Route 9 · South Lamar","Van 4 · Priya K.","40 stops, 44 packs","30 empties","Planned")]))
stops=''.join(f'<div style="display: flex; gap: 10px; align-items: center; font-size: 13px; border-top: 1px solid {G1}; padding-top: 7px"><span style="{MONO}; font-size: 11px; width: 26px; color: {T2}">{a}</span><span style="flex: 1 1 auto">{b}</span><span style="color: {T2}">{c}</span><span style="font-weight: 600; width: 64px; text-align: right">{d}</span></div>' for a,b,c,d in [("1","1204 Kenwood Ave","12-pack","6:18"),("2","1310 Kenwood Ave","6-pack + empties","6:23"),("3","908 Cumberland Rd","24-pack","6:31"),("…","38 more stops","",""),("42","2101 Alta Vista","12-pack","10:44")])
hdr=btn("Re-optimize routes","#",False,40)+btn("Publish to drivers","#",True,40)
body=f"""{askbar("e.g. &quot;Move the 5 Mueller stops on Route 7 to Van 3&quot;")}
<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
<div style="width: 320px; flex: none; display: flex; flex-direction: column; gap: 8px">{lab("TOMORROW · 4 ROUTES · 169 PACKS")}{rl}</div>
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 12px; min-width: 0">{ph("100%","MAP · ROUTE 3 IN ORDER, OTHERS FADED","; flex: 1 1 auto")}</div>
<div style="width: 380px; flex: none; display: flex; flex-direction: column; gap: 12px">
{card(f'<div style="display: flex; justify-content: space-between; align-items: baseline"><span style="font-size: 17px; font-weight: 600">Route 3 · Van 1</span><span style="font-size: 13px; color: {T2}">6:00 to 10:52 am</span></div><div style="font-size: 13px; color: {T2}">Driver Dana R. · 61 mi · leaves the micro-factory at 6:00</div>'+stops)}
{card(lab("LOAD ORDER")+f'<div style="font-size: 13px; line-height: 19px">Packs load in reverse: stop 42 goes in first, stop 1 last, so each pack is by the door when the van arrives. The driver app scans each pack as it loads.</div><div style="display: flex; justify-content: space-between; font-size: 13px; border-top: 1px solid {G1}; padding-top: 8px"><span style="color: {T2}">Loaded</span><span style="font-weight: 600">18 of 46</span></div>')}
</div></div>"""
shell('OpsRoutes','Routes','Routes',hdr,body)


# O8 Ledger admin
def lines(items):
    return ''.join(f'<div style="display: flex; justify-content: space-between; font-size: 13px; border-top: 1px solid {G1}; padding-top: 7px; {"font-weight: 600" if a.startswith("Total") else ""}"><span style="color: {INK if a.startswith("Total") else T2}">{a}</span><span style="font-weight: 600">{b}</span></div>' for a,b in items)
ex=[("ev_99a1","Scan counted twice in 4 s","Joe&#39;s Burgers","−1 scan","Auto-reversed"),("ev_99b7","Print failed after charge","Maple Realty","−1 print","Auto-reversed"),("ev_9a02","Order refunded by store","Joe&#39;s Burgers","−commission","Auto-reversed"),("ev_9a10","Payment card declined","Austin Daily","$ —",badge("Needs a person",dashed=True))]
hdr=chip("Yesterday · Oct 17",True)+chip("This month")+btn("Publish Oct 17","#",True,40)
body=f"""{askbar("e.g. &quot;How much did we donate in Austin this month, and to whom?&quot;")}
{tiles([("Bottles","3,912","3,880 free · 32 custom"),("Events matched to charges","99.99%","4 exceptions"),("Money in","$ IN","ads, scans, AR, commission, custom"),("Money out","$ OUT","water, cans, print, delivery"),("To charity","$391.20","10¢ × 3,912 bottles")])}
<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 12px; min-width: 0">
{card(f'<div style="display: flex; justify-content: space-between">{lab("EXCEPTIONS · OCT 17")}<span style="font-size: 12px; color: {T2}">Corrections are new lines. Nothing is ever deleted.</span></div>'+table(["Event","What happened","Who","Change","Status"],ex))}
<div style="display: flex; gap: 12px">
{card(lab("MONEY IN")+lines([("Prints","$ —"),("Scans","$ —"),("AR launches","$ —"),("Commission","$ —"),("Custom bottles","$ —"),("Total in","$ IN")]),"; flex: 1 1 0")}
{card(lab("MONEY OUT")+lines([("Water and cans","$ —"),("Labels and ink","$ —"),("Delivery","$ —"),("Charity","$391.20"),("Total out","$ OUT")]),"; flex: 1 1 0")}
</div></div>
<div style="width: 380px; flex: none; display: flex; flex-direction: column; gap: 12px">
{card(lab("WHAT THE PUBLIC WILL SEE")+f'<div style="font-size: 13px; line-height: 19px">Totals per day and per city, cost per bottle, money in and out, and every charity transfer with its receipt. No names of people. Advertisers appear only if they opt in.</div><a href="#" style="font-size: 13px; font-weight: 600">Preview the public page</a>')}
{card(lab("CHARITY TRANSFER")+f'<div style="font-size: 15px; font-weight: 600">$391.20 → Austin Parks Foundation</div><div style="font-size: 13px; color: {T2}">From ATX machines and routes, Oct 17. Paid weekly.</div><div style="display: flex; gap: 8px">{btn("Attach receipt","#",False,38)}</div>')}
{card(f'<div style="font-size: 13px; line-height: 19px; color: {T2}">Publishing locks the day. Anyone can check that every charge traces back to a real print, scan, AR launch or sale.</div>',"; background: "+G2+"; border-color: "+G2)}
</div></div>"""
shell('OpsLedger','Ledger admin','Ledger admin',hdr,body)

# O9 Support
inbox=''.join(f'<a href="#" style="display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: 10px; text-decoration: none; {"background: "+G1 if i==0 else ""}"><span style="display: flex; justify-content: space-between; gap: 8px"><span style="font-size: 14px; font-weight: 600">{a}</span><span style="font-size: 12px; color: {T2}; white-space: nowrap">{d}</span></span><span style="font-size: 12px; color: {T2}">{b}</span><span>{badge(c)}</span></a>' for i,(a,b,c,d) in enumerate([("AR didn&#39;t load","Scanned bottle, nothing happened","Consumer","4 min"),("Wrong name on bottle","Pack #8790 · Route 7","Consumer","22 min"),("Charged for 2 scans?","Joe&#39;s Burgers","Advertiser","1 h"),("Gate code changed","1310 Kenwood Ave","Driver","2 h"),("Machine ate my order","ATX-022","Consumer","3 h")]))
tl=''.join(f'<div style="display: flex; gap: 12px; font-size: 12px; {MONO}; padding: 5px 0; border-bottom: 1px solid {G1}"><span style="color: {T2}; width: 64px; flex: none">{t}</span><span style="width: 140px; flex: none; font-weight: 600">{e}</span><span style="color: {T2}">{d}</span></div>' for t,e,d in [("13:55:02","label.printed","ATX-014 · 3 ads · confirmed"),("13:55:40","unit.dispensed","picked up"),("14:10:17","unit.scanned","slot 2 · Joe&#39;s Burgers"),("14:10:18","ar.failed","model didn&#39;t load · iOS 17 · not billed")])
hdr=chip("Open · 12",True)+chip("Consumers")+chip("Advertisers")+chip("Drivers")
body=f"""<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
<div style="width: 300px; flex: none; display: flex; flex-direction: column; gap: 4px">{lab("INBOX · NEWEST FIRST")}{inbox}</div>
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 12px; min-width: 0">
{card('<div style="font-size: 17px; font-weight: 600">AR didn&#39;t load</div><div style="font-size: 14px; line-height: 20px">&quot;I scanned the burger ad on my bottle and pointed my phone, but nothing showed up.&quot;</div><div style="font-size: 12px; color: '+T2+'">Sam P. · app user · bottle u_7f3a</div>')}
{card(lab("THIS BOTTLE&#39;S HISTORY · ATTACHED AUTOMATICALLY")+f'<div style="display: flex; flex-direction: column">{tl}</div>')}
{card(lab("SUGGESTED REPLY")+'<div style="font-size: 14px; line-height: 20px">Sorry about that, Sam. The 3D burger didn&#39;t load on your phone, and we&#39;ve told Joe&#39;s Burgers so they can fix it. Here&#39;s their free fries offer so you don&#39;t miss out.</div><div style="display: flex; gap: 8px">'+btn("Send","#",True,40)+btn("Edit","#",False,40)+'</div>',"; flex: 1 1 auto")}
</div>
<div style="width: 320px; flex: none; display: flex; flex-direction: column; gap: 12px">
{card(lab("BILLING CHECK")+'<div style="font-size: 14px; line-height: 20px">The scan was billed (it loaded). The AR launch failed, so it was <b>not</b> billed. Nothing to refund.</div>')}
{card(lab("FIX IT")+'<div style="display: flex; flex-direction: column; gap: 8px">'+''.join(f'<a href="#" style="height: 38px; border-radius: 19px; border: 1px solid {B}; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; text-decoration: none">{x}</a>' for x in ["Send the offer anyway","Tell the advertiser","Report AR bug to plug-in maker","Give a free custom bottle credit"])+'</div>')}
</div></div>"""
shell('OpsSupport','Support','Support',hdr,body)

c=json.load(open(P+'canvas.json'))
for i,(n,t) in enumerate([('OpsMap','O1 · Live map'),('OpsMachine','O2.1 · Machine detail'),('OpsQueue','O3 · Print queue'),('OpsReview','O7 · Content review'),('OpsLines','O4 · Micro-factory lines'),('OpsPacks','O5 · Packs'),('OpsRoutes','O6 · Routes'),('OpsLedger','O8 · Ledger admin'),('OpsSupport','O9 · Support')]):
    c['boards'][n+'.dc.html']={"x":i*1520,"y":6900,"w":1440,"h":900,"title":t,"is_interactive":True}
    if n+'.dc.html' not in c['order']: c['order'].append(n+'.dc.html')
c['notes']['step3c']={"x":0,"y":6600,"text":"Step 3 · Wireframes: operations","kind":"title1","maxW":13600}
json.dump(c,open(P+'canvas.json','w'),indent=2)
