import sys,json
P=sys.argv[1]
import os
_D=os.path.dirname(os.path.abspath(__file__))
__file__=_D+'/ops.py'
exec(open(__file__).read())
WNAV=[('Company setup','WlSetup'),('Modules and adapters','WlModules'),('Products and layouts','WlProducts'),('Rules and prices','WlRules'),('Transparency',None),('Team and roles',None),('API keys and webhooks',None),('License and billing',None)]
def wshell(fname,title,active,right_hdr,body):
    side=''.join(f'<a href="{(f+".dc.html") if f else "#"}" style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px; font-size: 14px; text-decoration: none; {"background: "+G1+"; font-weight: 600" if n==active else "color: "+T2}"><span style="{MONO}; font-size: 10px; color: {T3}">W{i+1}</span>{n}</a>' for i,(n,f) in enumerate(WNAV))
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
<div style="width: 240px; flex: none; border-right: 1px solid {B}; padding: 22px 14px; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px">
<div style="display: flex; align-items: center; gap: 10px; padding: 0 12px 4px"><span style="width: 28px; height: 28px; border-radius: 8px; background: {G1}; border: 1px solid {B}"></span><span style="font-size: 18px; font-weight: 600">Peak Spring</span></div>
<div style="{MONO}; font-size: 10px; letter-spacing: 0.12em; color: {T2}; padding: 0 12px 16px">LICENSEE CONSOLE</div>
{side}
<div style="margin-top: auto; padding: 0 12px; font-size: 12px; color: {T2}; line-height: 17px">Runs on the FreeWater platform. Your brand everywhere customers look.</div>
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
def field(a,b,note=''):
    n=f'<span style="font-size: 12px; color: {T2}">{note}</span>' if note else ''
    return f'<div style="display: flex; flex-direction: column; gap: 4px"><span style="font-size: 13px; font-weight: 600">{a}</span><span style="height: 40px; border: 1px solid {B}; border-radius: 10px; display: flex; align-items: center; padding: 0 12px; font-size: 14px">{b}</span>{n}</div>'

# W1 Company setup
steps=''.join(f'<div style="display: flex; align-items: center; gap: 10px; font-size: 14px; border-top: 1px solid {G1}; padding-top: 8px"><span style="width: 22px; height: 22px; flex: none; border-radius: 11px; box-sizing: border-box; {"background: "+INK+"; color: #fff" if d else "border: 1px solid "+B}; display: flex; align-items: center; justify-content: center; font-size: 12px">{"✓" if d else ""}</span><span style="{"" if d else "color: "+T2}">{t}</span></div>' for t,d in [("Brand and domain",True),("Modules and adapters",True),("Products and layouts",False),("Rules and prices",False),("Transparency",False),("Team",False),("Connect payments",False),("Go live",False)])
swatches=''.join(f'<span style="width: 40px; height: 40px; border-radius: 10px; background: {c}; border: 1px solid {B}"></span>' for c in [INK,"#4b5468","#c3c9d4","#ffffff"])
phone=f'''<div style="width: 250px; height: 500px; flex: none; border: 2px solid {INK}; border-radius: 34px; padding: 22px 14px; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px">
<div style="display: flex; align-items: center; gap: 8px"><span style="width: 24px; height: 24px; border-radius: 6px; background: {G1}; border: 1px solid {B}"></span><span style="font-size: 15px; font-weight: 600">Peak Spring</span></div>
<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px">{''.join(f'<span style="background: {G2}; border-radius: 8px; padding: 6px; font-size: 11px"><b style="font-size: 14px">{a}</b><br>{b}</span>' for a,b in [("40","bottles"),("$4","donated"),("$40","saved")])}</div>
<div style="height: 46px; border-radius: 12px; background: {INK}; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600">Scan any bottle · AR</div>
{ph("130px","THEIR HOME DELIVERY CARD")}
{ph("90px","SAVED FROM SCANS")}
<div style="margin-top: auto; font-size: 10px; color: {T2}; text-align: center">Same app, their brand</div></div>'''
hdr=btn("Preview their app","#",False,40)+btn("Save","#",True,40)
body=f'''{askbar("e.g. &quot;Set us up like FreeWater Austin, with our colors and our charity&quot;")}
<div style="display: flex; gap: 24px; flex: 1 1 auto; min-height: 0">
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 14px; min-width: 0">
{card(lab("BRAND")+f'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px">{field("Company name","Peak Spring Water Co.")}{field("App and product name","Peak Spring")}{field("Web address","water.peakspring.com","Scan links and the app use this")}{field("Support email","help@peakspring.com")}</div><div style="display: flex; gap: 24px; align-items: center"><div style="display: flex; flex-direction: column; gap: 6px"><span style="font-size: 13px; font-weight: 600">Logo</span><span style="width: 120px; height: 56px; border: 1px dashed {T3}; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 12px; color: {T2}">Upload</span></div><div style="display: flex; flex-direction: column; gap: 6px"><span style="font-size: 13px; font-weight: 600">Colors</span><div style="display: flex; gap: 8px">{swatches}</div></div></div>')}
{card(lab("LOCKED PANEL ON EVERY BOTTLE AND BOX")+f'<div style="font-size: 14px; line-height: 20px">Your company panel replaces the FreeWater panel: required product facts, your logo, and the receipt QR that opens your open-books page. Advertisers and custom designs can never cover it.</div>')}
</div>
<div style="display: flex; gap: 20px; flex: none">
{phone}
<div style="width: 230px; flex: none">{card(lab("GO-LIVE CHECKLIST")+steps)}</div>
</div></div>'''
wshell('WlSetup','Company setup','Company setup',hdr,body)

# W2 Modules and adapters
def mod(name,role,cur,alts,on=True,health="Healthy"):
    tog=f'<span style="width: 40px; height: 24px; border-radius: 12px; background: {INK if on else G1}; position: relative; flex: none"><span style="position: absolute; top: 3px; {"right" if on else "left"}: 3px; width: 18px; height: 18px; border-radius: 9px; background: #fff"></span></span>'
    return f'''<div style="border: 1px solid {B}; border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 8px; {"" if on else "background: "+G2}">
<div style="display: flex; justify-content: space-between; align-items: center"><span style="font-size: 15px; font-weight: 600">{name}</span>{tog}</div>
<span style="font-size: 12px; color: {T2}; line-height: 16px">{role}</span>
<div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid {G1}; padding-top: 8px"><span style="display: flex; flex-direction: column"><span style="{MONO}; font-size: 10px; color: {T2}">USING</span><span style="font-size: 13px; font-weight: 600">{cur}</span></span><a href="#" style="font-size: 13px; font-weight: 600">Swap</a></div>
<span style="font-size: 11px; color: {T2}">{alts} · {health}</span></div>'''
mods=[("Ads and slots","Fills printed slots at print time","FreeWater ad engine","or your own ad server"),
("Print engine","Renders each label with a unique QR","FreeWater renderer","or bring your own"),
("Experience plug-ins","What a scan or AR launch opens","24 installed","Marketplace"),
("Custom designs","Paid bottles designed by chat","FreeWater designer · Claude","or another AI model"),
("Orders and payments","Charges, refunds, payouts","Stripe","or Adyen, Square"),
("Packs and routes","6/12/24 packs and home delivery","Google OR-Tools routing","or your own fleet system",False,"Off"),
("Ledger and open books","Every event, every charge, public","FreeWater ledger","always on for Open Books badge"),
("Machines and micro-factories","Drivers for printers and lines","Model 6 driver","+ 3 printer adapters")]
grid=''.join(mod(*m) for m in mods)
hdr=chip("All 8",True)+chip("On · 7")+chip("Off · 1")+btn("Marketplace","#",False,40)
body=f'''{askbar("e.g. &quot;Switch payments to Adyen and tell me what changes&quot;")}
<div style="display: flex; align-items: center; gap: 12px; background: {G2}; border-radius: 12px; padding: 12px 16px"><span style="{MONO}; font-size: 11px; letter-spacing: 0.12em; color: {T2}">CORE · ALWAYS ON</span><span style="font-size: 13px">Companies and brands · users and permissions · bottle and pack IDs · events · module contracts</span></div>
<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px">{grid}</div>
<div style="font-size: 13px; color: {T2}">Every module follows the same contract, so swapping one never touches the others. A swap runs in a test copy first, then goes live with one click.</div>'''
wshell('WlModules','Modules and adapters','Modules and adapters',hdr,body)

# W3 Products and layouts
def strip(n,sel=False):
    cells=''.join(f'<span style="flex: 1 1 0; border-right: 1px solid {B}; display: flex; align-items: center; justify-content: center; font-size: 11px; color: {T2}">{i+1}</span>' for i in range(n))
    return f'<div style="display: flex; flex-direction: column; gap: 6px"><div style="display: flex; height: 56px; border: {"2px solid "+INK if sel else "1px solid "+B}; border-radius: 8px; overflow: hidden">{cells}<span style="width: 34px; flex: none; background: {INK}; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 9px; {MONO}">PANEL</span></div><span style="font-size: 12px; {"font-weight: 600" if sel else "color: "+T2}">{n} slot{"s" if n>1 else ""}{" · selected" if sel else ""}</span></div>'
prods=''.join(f'<a href="#" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-radius: 10px; text-decoration: none; {"background: "+G1 if i==0 else ""}"><span style="display: flex; flex-direction: column"><span style="font-size: 14px; font-weight: 600">{a}</span><span style="font-size: 12px; color: {T2}">{b}</span></span>{badge(c, c=="On")}</a>' for i,(a,b,c) in enumerate([("16 oz bottle","Aluminum · machines and packs","On"),("25 oz bottle","Aluminum · packs only","On"),("6-pack box","5 printed faces","On"),("12-pack box","5 printed faces","On"),("24-pack box","5 printed faces","Off")]))
faces=''.join(f'<div style="display: flex; justify-content: space-between; font-size: 13px; border-top: 1px solid {G1}; padding-top: 6px"><span style="color: {T2}">{a}</span><span style="font-weight: 600">{b}</span></div>' for a,b in [("Top, front, back, right","Ad faces"),("Left","Locked company panel"),("Bottom","Blank"),("Corner","Small stop code for drivers")])
hdr=btn("Add product","#",False,40)
body=f'''<div style="display: flex; gap: 24px; flex: 1 1 auto; min-height: 0">
<div style="width: 280px; flex: none; display: flex; flex-direction: column; gap: 4px">{lab("PRODUCTS")}{prods}</div>
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 14px; min-width: 0">
{card(lab("16 OZ LABEL · LAYOUTS THE AD ENGINE CAN USE")+f'<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px">{strip(1)}{strip(2)}{strip(3,True)}{strip(4)}{strip(6)}<div style="display: flex; align-items: center; justify-content: center; border: 1px dashed {T3}; border-radius: 8px; height: 56px; font-size: 13px; color: {T2}">+ New layout</div></div><div style="font-size: 13px; color: {T2}">The engine picks a layout per bottle based on what sold. Custom designs can use the whole label except the panel.</div>')}
<div style="display: flex; gap: 14px">
{card(lab("LABEL SIZE AND PRINT")+''.join(f'<div style="display: flex; justify-content: space-between; font-size: 13px; border-top: 1px solid {G1}; padding-top: 6px"><span style="color: {T2}">{a}</span><span style="font-weight: 600">{b}</span></div>' for a,b in [("Label size","8.6 × 4.5 in"),("Seam overlap","0.25 in, nothing printed"),("Resolution","1200 dpi"),("Printer adapters","3 approved")]),"; flex: 1 1 0")}
{card(lab("BOX FACES")+faces,"; flex: 1 1 0")}
</div></div></div>'''
wshell('WlProducts','Products and layouts','Products and layouts',hdr,body)

# W4 Rules and prices
blocked=''.join(chip(x,True) for x in ["Alcohol","Tobacco and vape","Gambling","Weapons"])+chip("+ Block more",dashed=True)
allowed=''.join(chip(x) for x in ["Food","Real estate","News","Local services","Events","Political (labeled)"])
def pr(a,b,n): return f'<div style="display: flex; justify-content: space-between; align-items: center; font-size: 14px; border-top: 1px solid {G1}; padding-top: 8px"><span style="display: flex; flex-direction: column"><span>{a}</span><span style="font-size: 12px; color: {T2}">{n}</span></span><span style="height: 36px; min-width: 90px; border: 1px solid {B}; border-radius: 8px; display: flex; align-items: center; justify-content: flex-end; padding: 0 10px; font-weight: 600">{b}</span></div>'
hdr=btn("Save rules","#",True,40)
body=f'''{askbar("e.g. &quot;Don&#39;t let two burger places share a bottle&quot;")}
<div style="display: flex; align-items: center; gap: 12px; background: {G2}; border-radius: 12px; padding: 10px 16px"><span style="{MONO}; font-size: 11px; letter-spacing: 0.12em; color: {T2}">EVERY VALUE IS A SETTING</span><span style="font-size: 13px">These are FreeWater&#39;s defaults. Each company can change, turn off or replace any of them.</span></div>
<div style="display: flex; gap: 20px; flex: 1 1 auto; min-height: 0">
<div style="flex: 1 1 0; display: flex; flex-direction: column; gap: 14px; min-width: 0">
{card(lab("AD CATEGORIES")+f'<span style="font-size: 13px; font-weight: 600">Never print</span><div style="display: flex; gap: 6px; flex-wrap: wrap">{blocked}</div><span style="font-size: 13px; font-weight: 600">Allowed</span><div style="display: flex; gap: 6px; flex-wrap: wrap">{allowed}</div>')}
{card(lab("ON EACH BOTTLE")+pr("Ads per bottle","1 to 6","the engine picks the layout")+pr("Competitors on one bottle","Not allowed","e.g. two burger places")+pr("Near schools","Food only","within 1,000 ft of a school machine"))}
</div>
<div style="flex: 1 1 0; display: flex; flex-direction: column; gap: 14px; min-width: 0">
{card(lab("PRICES ADVERTISERS PAY")+pr("Per printed ad","$ —","1/6 slot; larger slots scale")+pr("Per scan","$ —","only if the experience loads")+pr("Per AR launch","$ —","only if it loads")+pr("Commission on sales","— %","completed sales only, reversed on refund")+pr("Repeat window","10 min","repeat scans by one person are free"))}
</div>
<div style="width: 340px; flex: none; display: flex; flex-direction: column; gap: 14px">
{card(f'<div style="display: flex; justify-content: space-between; align-items: center">{lab("GIVING · OPTIONAL")}<span style="width: 40px; height: 24px; border-radius: 12px; background: {INK}; position: relative"><span style="position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; border-radius: 9px; background: #fff"></span></span></div>'+f'<div style="display: flex; gap: 6px; flex-wrap: wrap">{chip("Per bottle",True)}{chip("% of revenue")}{chip("None")}</div>'+pr("Amount","10¢","any amount, including 0")+pr("Charity","Per machine","or one for the whole company")+f'<div style="font-size: 12px; color: {T2}">Turned off, every charity line disappears from the app, labels, receipts and public ledger.</div>')}
{card(lab("WHAT CONSUMERS PAY")+f'<div style="display: flex; gap: 6px; flex-wrap: wrap">{chip("Free, ad-paid",True)}{chip("Discounted")}{chip("Full price")}</div><div style="font-size: 12px; color: {T2}">Ads can lower the price instead of making it free.</div>')}
{card(lab("CUSTOM BOTTLES")+pr("Price per bottle","$ —","customer pays")+pr("Approval","AI + proof","customer approves; people review flags"))}
</div></div>'''
wshell('WlRules','Rules and prices','Rules and prices',hdr,body)

c=json.load(open(P+'canvas.json'))
for i,(n,t) in enumerate([('WlSetup','W1 · Company setup'),('WlModules','W2 · Modules and adapters'),('WlProducts','W3 · Products and layouts'),('WlRules','W4 · Rules and prices')]):
    c['boards'][n+'.dc.html']={"x":i*1520,"y":11400,"w":1440,"h":900,"title":t,"is_interactive":True}
    if n+'.dc.html' not in c['order']: c['order'].append(n+'.dc.html')
c['notes']['step3f']={"x":0,"y":11100,"text":"Step 3 · Wireframes: white-label console","kind":"title1","maxW":5960}
json.dump(c,open(P+'canvas.json','w'),indent=2)
