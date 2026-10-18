import sys,json
P=sys.argv[1]
exec(open(__file__.replace('ledger.py','adv.py')).read())
HEAD='''<!doctype html>
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
'''
TAIL='''
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{
renderVals() {{
return {{}};
}}
}}
</script>
</body>
</html>
'''
def write(name,title,w,h,inner):
    open(P+name+'.dc.html','w').write(HEAD.format(title=title)+inner+TAIL.format(w=w,h=h))
NAV=[("Live totals","LedgerLive.dc.html"),("Look up a bottle","LedgerBottle.dc.html"),("By month",None),("Donations","LedgerDonations.dc.html"),("Open Books companies",None),("How we count",None)]
def topnav(active):
    links=''.join(f'<a href="{h or "#"}" style="font-size: 14px; text-decoration: none; {"font-weight: 600; border-bottom: 2px solid "+INK+"; padding-bottom: 4px" if n==active else "color: "+T2}">{n}</a>' for n,h in NAV)
    return f'<div style="display: flex; align-items: center; justify-content: space-between; padding: 20px 48px; border-bottom: 1px solid {B}"><div style="display: flex; align-items: baseline; gap: 10px"><span style="font-size: 20px; font-weight: 600">freewater</span><span style="{MONO}; font-size: 11px; letter-spacing: 0.12em; color: {T2}">OPEN BOOKS</span></div><div style="display: flex; gap: 26px">{links}</div></div>'
def stat(a,b,c,size=30):
    return f'<div style="flex: 1 1 0; display: flex; flex-direction: column; gap: 2px; border-top: 2px solid {INK}; padding-top: 10px"><span style="font-size: 13px; color: {T2}">{a}</span><span style="font-size: {size}px; font-weight: 600; line-height: 1.15">{b}</span><span style="font-size: 12px; color: {T2}">{c}</span></div>'

def table(heads,rows,align=None,bold0=True):
    align=align or ['left']*len(heads)
    th=''.join(f'<th style="text-align: {align[i]}; font-size: 12px; font-weight: 600; color: {T2}; padding: 8px 10px; border-bottom: 1px solid {B}; white-space: nowrap">{h}</th>' for i,h in enumerate(heads))
    tr=''.join('<tr>'+''.join(f'<td style="text-align: {align[i]}; font-size: 13px; padding: 8px 10px; border-bottom: 1px solid {G1}; {"font-weight: 600; " if i==0 and bold0 else ""}{MONO+"; font-size: 12px; " if i==0 else ""}">{c}</td>' for i,c in enumerate(r))+'</tr>' for r in rows)
    return f'<table style="border-collapse: collapse; width: 100%"><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table>'

# L1 Live totals
costs=[("Spring water",14),("Aluminum bottle and cap",30),("Label and ink",12),("Machine or delivery",22),("Charity",10),("Platform and people",12)]
stack=''.join(f'<span title="{a}" style="width: {w}%; height: 34px; background: {["#1d2433","#4b5468","#8a93a3","#c3c9d4","#1d2433","#e6e9ef"][i]}; {"background-image: repeating-linear-gradient(135deg, transparent 0 6px, rgba(255,255,255,.35) 6px 12px);" if a=="Charity" else ""}"></span>' for i,(a,w) in enumerate(costs))
legend=''.join(f'<div style="display: flex; justify-content: space-between; font-size: 13px; border-top: 1px solid {G1}; padding-top: 6px"><span style="color: {T2}">{a}</span><span style="font-weight: 600">{"10¢" if a=="Charity" else "$ —"}</span></div>' for a,w in costs)
feed=''.join(f'<div style="display: flex; gap: 10px; font-size: 13px; padding: 7px 0; border-top: 1px solid {G1}"><span style="{MONO}; font-size: 11px; color: {T2}; width: 56px; flex: none; padding-top: 2px">{t}</span><span>{d}</span></div>' for t,d in [("2 s ago","Bottle printed at ATX-014 · 3 ads · 10¢ to Austin Parks Foundation"),("5 s ago","12-pack delivered on Route 3 · 6 empties collected"),("9 s ago","Scan billed to an advertiser · experience loaded"),("14 s ago","Failed print at ATX-022 · not billed to anyone"),("21 s ago","Custom bottle printed · paid by a customer")])
months=[40,46,52,61,70,84]
chart=''.join(f'<div style="flex: 1 1 0; display: flex; flex-direction: column; align-items: center; gap: 4px; justify-content: flex-end; height: 100%"><div style="display: flex; gap: 3px; align-items: flex-end; height: 100%; width: 100%"><span style="flex: 1 1 0; height: {m}%; background: {INK}; border-radius: 3px 3px 0 0"></span><span style="flex: 1 1 0; height: {m*0.82:.0f}%; background: {T3}; border-radius: 3px 3px 0 0"></span></div><span style="font-size: 11px; color: {T2}">{l}</span></div>' for m,l in zip(months,["May","Jun","Jul","Aug","Sep","Oct"]))
inner=f'''<div style="width: 1440px; height: 900px; box-sizing: border-box; background: #ffffff; font-family: 'IBM Plex Sans', 'Helvetica Neue', sans-serif; color: {INK}; display: flex; flex-direction: column">
{topnav("Live totals")}
<div style="flex: 1 1 auto; padding: 28px 48px; display: flex; flex-direction: column; gap: 24px; min-height: 0">
<div style="display: flex; justify-content: space-between; align-items: flex-end"><div style="display: flex; flex-direction: column; gap: 6px"><div style="font-size: 34px; font-weight: 600">Every bottle, every dollar. Live.</div><div style="font-size: 15px; color: {T2}">What came in, what went out, and what went to charity. Updated every few seconds.</div></div><div style="display: flex; gap: 8px">{chip("All cities",True)}{chip("Austin")}{chip("All time",True)}{chip("This month")}</div></div>
<div style="display: flex; gap: 28px">{stat("Free bottles given","1,284,330","since launch",34)}{stat("Donated to charity","$128,433","10¢ every bottle",34)}{stat("Money in","$ IN","ads, scans, AR, commission, custom",34)}{stat("Money out","$ OUT","every cost, line by line",34)}{stat("Corrections","212","all public, none deleted",34)}</div>
<div style="display: flex; gap: 24px; flex: 1 1 auto; min-height: 0">
{card(f'<div style="display: flex; justify-content: space-between">{lab("WHERE ONE BOTTLE&#39;S MONEY GOES")}<span style="font-size: 12px; color: {T2}">Average cost per bottle: $ —</span></div><div style="display: flex; border-radius: 6px; overflow: hidden">{stack}</div>{legend}',"; flex: 1 1 0")}
{card(f'<div style="display: flex; justify-content: space-between">{lab("MONEY IN VS OUT BY MONTH")}<span style="font-size: 12px; color: {T2}">■ in &nbsp; <span style="color: {T3}">■</span> out</span></div><div style="display: flex; gap: 14px; align-items: flex-end; flex: 1 1 auto; min-height: 0">{chart}</div>',"; flex: 1 1 0")}
{card(f'<div style="display: flex; justify-content: space-between">{lab("HAPPENING NOW")}<span style="font-size: 12px; color: {T2}">No personal data, ever</span></div>{feed}<a href="LedgerBottle.dc.html" style="margin-top: auto; font-size: 13px; font-weight: 600">Have a bottle? Look up its receipt</a>',"; width: 400px; flex: none; box-sizing: border-box")}
</div></div></div>'''
write('LedgerLive','L1 Live totals',1440,900,inner)

# L2 Bottle receipt (phone) — same page opened from the FreeWater QR
def rl(a,b,bold=False): return f'<div style="display: flex; justify-content: space-between; font-size: 14px; padding: 7px 0; border-top: 1px solid {G1}; {"font-weight: 600" if bold else ""}"><span style="color: {INK if bold else T2}">{a}</span><span style="font-weight: 600">{b}</span></div>'
inner=f'''<div style="width: 390px; height: 844px; box-sizing: border-box; background: #ffffff; font-family: 'IBM Plex Sans', 'Helvetica Neue', sans-serif; color: {INK}; display: flex; flex-direction: column; gap: 14px; padding: 48px 20px 24px">
<div style="display: flex; flex-direction: column; gap: 4px"><div style="{MONO}; font-size: 11px; letter-spacing: 0.12em; color: {T2}">OPEN BOOKS · FROM THE FREEWATER QR</div><div style="font-size: 24px; font-weight: 600">This bottle&#39;s receipt</div><div style="font-size: 13px; color: {T2}">u_7f3a · printed Oct 17, 1:55 pm at ATX-014, Congress Ave</div></div>
<div style="border: 1px solid {B}; border-radius: 14px; padding: 6px 16px 10px">
{lab("WHAT IT EARNED")}
{rl("3 printed ads","$ —")}{rl("2 scans, 1 AR launch","$ —")}{rl("Commission on 1 order","$ —")}{rl("Total earned","$ —",True)}</div>
<div style="border: 1px solid {B}; border-radius: 14px; padding: 6px 16px 10px">
{lab("WHAT IT COST")}
{rl("Water, bottle and cap","$ —")}{rl("Label and ink","$ —")}{rl("Machine and restock","$ —")}{rl("Total cost","$ —",True)}</div>
<div style="background: {INK}; color: #fff; border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px"><span style="font-size: 18px; font-weight: 600">10¢ to Austin Parks Foundation</span><span style="font-size: 13px; opacity: .85">Sent Oct 20 in transfer T-1042 · <u>see the bank receipt</u></span></div>
<div style="font-size: 12px; line-height: 17px; color: {T2}">Part of the published day Oct 17. Every number above traces back to a logged print, scan or sale. Corrections show as new lines.</div>
<div style="margin-top: auto; display: flex; gap: 8px"><div style="flex: 1 1 auto; height: 44px; border-radius: 22px; border: 1px solid {T3}; display: flex; align-items: center; padding: 0 16px; font-size: 14px; color: {T3}">Look up another bottle code</div><a href="LedgerLive.dc.html" style="height: 44px; padding: 0 16px; border-radius: 22px; background: {INK}; color: #fff; display: flex; align-items: center; font-size: 14px; font-weight: 600; text-decoration: none">All totals</a></div>
</div>'''
write('LedgerBottle','L2 Bottle receipt',390,844,inner)

# L4 Donations
rows=[("T-1042","Oct 20","Austin Parks Foundation","$2,738.40","27,384 bottles · Austin machines",'<a href="#" style="font-weight: 600">Receipt</a>'),("T-1041","Oct 20","Central Texas Food Bank","$1,915.10","19,151 bottles · Austin routes",'<a href="#" style="font-weight: 600">Receipt</a>'),("T-1040","Oct 13","Austin Parks Foundation","$2,604.00","26,040 bottles",'<a href="#" style="font-weight: 600">Receipt</a>'),("T-1039","Oct 13","Central Texas Food Bank","$1,822.70","18,227 bottles",'<a href="#" style="font-weight: 600">Receipt</a>'),("T-1038","Oct 6","charity: water","$3,110.20","31,102 bottles · custom bottles",'<a href="#" style="font-weight: 600">Receipt</a>')]
bars=''.join(f'<div style="display: flex; flex-direction: column; gap: 4px"><div style="display: flex; justify-content: space-between; font-size: 13px"><span>{a}</span><span style="font-weight: 600">{b}</span></div><div style="height: 10px; border-radius: 5px; background: {G1}"><div style="width: {w}%; height: 10px; border-radius: 5px; background: {INK}"></div></div></div>' for a,b,w in [("Austin Parks Foundation","$58,210",100),("Central Texas Food Bank","$41,066",71),("charity: water","$29,157",50)])
inner=f'''<div style="width: 1440px; height: 900px; box-sizing: border-box; background: #ffffff; font-family: 'IBM Plex Sans', 'Helvetica Neue', sans-serif; color: {INK}; display: flex; flex-direction: column">
{topnav("Donations")}
<div style="flex: 1 1 auto; padding: 28px 48px; display: flex; flex-direction: column; gap: 24px; min-height: 0">
<div style="display: flex; flex-direction: column; gap: 6px"><div style="font-size: 34px; font-weight: 600">$128,433 donated. Here&#39;s every transfer.</div><div style="font-size: 15px; color: {T2}">10¢ from every bottle, paid weekly, each with the bank receipt.</div></div>
<div style="display: flex; gap: 24px; flex: 1 1 auto; min-height: 0">
{card(lab("TRANSFERS · NEWEST FIRST")+table(["Transfer","Date","Charity","Amount","From","Proof"],rows),"; flex: 1 1 auto; min-width: 0")}
<div style="width: 420px; flex: none; display: flex; flex-direction: column; gap: 16px">
{card(lab("BY CHARITY · ALL TIME")+bars)}
{card(lab("HOW A CHARITY IS CHOSEN")+f'<div style="font-size: 14px; line-height: 20px">Each machine and route has a charity, shown on the app and the scan page. Custom bottle buyers pick their own. Pending: $391.20 for Oct 17, sent with the next weekly transfer.</div>')}
</div></div></div></div>'''
write('LedgerDonations','L4 Donations',1440,900,inner)

c=json.load(open(P+'canvas.json'))
for n,t,x,w,h in [('LedgerLive','L1 · Live totals (public)',0,1440,900),('LedgerBottle','L2 · Bottle receipt (also C2)',1520,390,844),('LedgerDonations','L4 · Donations',1990,1440,900)]:
    c['boards'][n+'.dc.html']={"x":x,"y":9900,"w":w,"h":h,"title":t,"is_interactive":True}
    if n+'.dc.html' not in c['order']: c['order'].append(n+'.dc.html')
c['notes']['step3e']={"x":0,"y":9600,"text":"Step 3 · Wireframes: public ledger (open books)","kind":"title1","maxW":3430}
json.dump(c,open(P+'canvas.json','w'),indent=2)
