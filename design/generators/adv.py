import json,sys
P=sys.argv[1]
INK='#1d2433';G1='#e6e9ef';G2='#f1f3f6';B='#c3c9d4';T2='#5b6475';T3='#8a93a3'
MONO="font-family: 'IBM Plex Mono', monospace"
def lab(t,extra=''): return f'<div style="{MONO}; font-size: 11px; letter-spacing: 0.12em; color: {T2}{extra}">{t}</div>'
def ph(h,label,extra=''):
    return f'''<div style="position: relative; height: {h}; border-radius: 12px; border: 1px solid {B}; background: {G2}; overflow: hidden{extra}"><svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" style="position: absolute; inset: 0; width: 100%; height: 100%"><line x1="0" y1="0" x2="100" y2="100" stroke="#d3d8e0" stroke-width="0.6" vector-effect="non-scaling-stroke"/><line x1="100" y1="0" x2="0" y2="100" stroke="#d3d8e0" stroke-width="0.6" vector-effect="non-scaling-stroke"/></svg><div style="position: absolute; left: 10px; top: 10px; {MONO}; font-size: 11px; color: {T2}; background: #ffffff; padding: 3px 8px; border-radius: 6px">{label}</div></div>'''
def btn(t,href='#',dark=True,h=44):
    s=f'background: {INK}; color: #ffffff' if dark else f'border: 1px solid {INK}'
    return f'<a href="{href}" style="display: inline-flex; align-items: center; justify-content: center; height: {h}px; padding: 0 22px; border-radius: {h//2}px; {s}; font-size: 14px; font-weight: 600; text-decoration: none">{t}</a>'
def chip(t,on=False,dashed=False):
    if on: s=f'background: {INK}; color: #ffffff'
    else: s=f'border: 1px {"dashed" if dashed else "solid"} {B}'
    return f'<span style="padding: 6px 12px; border-radius: 16px; {s}; font-size: 13px; white-space: nowrap">{t}</span>'
def card(inner,extra=''): return f'<div style="border: 1px solid {B}; border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 10px{extra}">{inner}</div>'
STEPS=[('Creative','AdCreative'),('Where and who','AdWhere'),('Scan experience','AdScan'),('Budget and price','AdBudget'),('Review and launch','AdReview')]
def composer(placeholder,attach):
    return f'''<div style="border: 1px solid {T3}; border-radius: 18px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px">
<div style="font-size: 14px; color: {T3}">{placeholder}</div>
<div style="display: flex; align-items: center; gap: 8px"><a href="#" aria-label="Attach" style="width: 32px; height: 32px; border-radius: 16px; border: 1px solid {B}; display: flex; align-items: center; justify-content: center; text-decoration: none; font-size: 18px">+</a><span style="font-size: 12px; color: {T2}; flex: 1 1 auto">{attach}</span><a href="#" aria-label="Talk" style="width: 32px; height: 32px; border-radius: 16px; border: 1px solid {B}; display: flex; align-items: center; justify-content: center; text-decoration: none; {MONO}; font-size: 10px">MIC</a><a href="#" aria-label="Send" style="width: 32px; height: 32px; border-radius: 16px; background: {INK}; color: #ffffff; display: flex; align-items: center; justify-content: center; text-decoration: none">↑</a></div></div>'''
def you(text,files=()):
    f=''.join(f'<span style="height: 40px; padding: 0 10px; border-radius: 8px; background: {G1}; border: 1px solid {B}; display: flex; align-items: center; {MONO}; font-size: 10px; color: {T2}">{x}</span>' for x in files)
    fr=f'<div style="display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end">{f}</div>' if files else ''
    return f'<div style="align-self: flex-end; max-width: 330px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end">{fr}<div style="background: {G2}; border-radius: 16px 16px 4px 16px; padding: 10px 12px; font-size: 14px; line-height: 20px">{text}</div></div>'
def ai(text,chips=()):
    c=''.join(f'<a href="#" style="padding: 6px 12px; border-radius: 16px; border: 1px solid {INK if i==0 else B}; font-size: 13px; {"font-weight: 600; " if i==0 else ""}text-decoration: none">{x}</a>' for i,x in enumerate(chips))
    return f'<div style="max-width: 360px; display: flex; flex-direction: column; gap: 8px"><div style="font-size: 14px; line-height: 20px">{text}</div><div style="display: flex; gap: 6px; flex-wrap: wrap">{c}</div></div>'
def chatpanel(title,sub,msgs,ph_,attach):
    return f'''<div style="width: 420px; flex: none; border-right: 1px solid {B}; display: flex; flex-direction: column; padding: 20px 24px; gap: 14px; box-sizing: border-box">
<div style="display: flex; flex-direction: column; gap: 2px"><div style="font-size: 16px; font-weight: 600">{title}</div><div style="font-size: 13px; color: {T2}">{sub}</div></div>
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 14px; overflow: hidden">{msgs}</div>
{composer(ph_,attach)}</div>'''
def askbar(t):
    return f'<div style="display: flex; align-items: center; gap: 10px; border: 1px solid {T3}; border-radius: 22px; padding: 0 8px 0 16px; height: 44px"><span style="{MONO}; font-size: 11px; color: {T2}">ASK</span><span style="font-size: 14px; color: {T3}; flex: 1 1 auto">{t}</span><span style="width: 30px; height: 30px; border-radius: 15px; background: {INK}; color: #ffffff; display: flex; align-items: center; justify-content: center; font-size: 14px">↑</span></div>'
def page(idx,title,body):
    name=STEPS[idx][1]
    side=''.join(f'<a href="{"AdCreative.dc.html" if n=="Campaigns" else "#"}" style="padding: 9px 12px; border-radius: 8px; font-size: 14px; text-decoration: none; {"background: "+G1+"; font-weight: 600" if n=="Campaigns" else "color: "+T2}">{n}</a>' for n in ['Overview','Campaigns','Creative library','Reports','Billing'])
    st=''
    for i,(s,f) in enumerate(STEPS):
        if i<idx: dot=f'background: {INK}; color: #ffffff'; c=INK; tx='✓'
        elif i==idx: dot=f'background: {INK}; color: #ffffff; box-shadow: 0 0 0 3px {G1}'; c=INK; tx=str(i+1)
        else: dot=f'border: 1px solid {B}; color: {T2}'; c=T2; tx=str(i+1)
        st+=f'<a href="{f}.dc.html" style="display: flex; align-items: center; gap: 8px; text-decoration: none; color: {c}; font-size: 13px; {"font-weight: 600" if i==idx else ""}"><span style="width: 24px; height: 24px; border-radius: 12px; {dot}; display: flex; align-items: center; justify-content: center; font-size: 12px; box-sizing: border-box">{tx}</span>{s}</a>'
        if i<4: st+=f'<span style="flex: 1 1 auto; height: 1px; background: {B}; min-width: 16px"></span>'
    prev=f'{STEPS[idx-1][1]}.dc.html' if idx>0 else 'AdCreative.dc.html'
    nxt=f'{STEPS[idx+1][1]}.dc.html' if idx<4 else '#'
    nlabel='Submit for review' if idx==4 else f'Next: {STEPS[idx+1][0]}'
    html=f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>A4.{idx+1} {STEPS[idx][0]}</title>
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
<div style="width: 220px; flex: none; border-right: 1px solid {B}; padding: 22px 14px; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px">
<div style="font-size: 20px; font-weight: 600; padding: 0 12px 4px">freewater</div>
<div style="{MONO}; font-size: 10px; letter-spacing: 0.12em; color: {T2}; padding: 0 12px 16px">ADVERTISER · WHITE-LABEL READY</div>
{side}
<div style="margin-top: auto; display: flex; align-items: center; gap: 10px; padding: 0 12px"><span style="width: 32px; height: 32px; border-radius: 8px; background: {G1}; border: 1px solid {B}"></span><span style="display: flex; flex-direction: column"><span style="font-size: 13px; font-weight: 600">Joe's Burgers</span><span style="font-size: 12px; color: {T2}">Austin, TX</span></span></div>
</div>
<div style="flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0">
<div style="padding: 18px 32px 16px; border-bottom: 1px solid {B}; display: flex; flex-direction: column; gap: 14px">
<div style="display: flex; justify-content: space-between; align-items: center"><div style="display: flex; flex-direction: column"><div style="font-size: 13px; color: {T2}">Campaigns / New campaign</div><div style="font-size: 22px; font-weight: 600">{title}</div></div><a href="#" style="font-size: 14px; font-weight: 600">Save draft</a></div>
<div style="display: flex; align-items: center; gap: 10px">{st}</div>
</div>
<div style="flex: 1 1 auto; display: flex; min-height: 0">{body}</div>
<div style="padding: 14px 32px; border-top: 1px solid {B}; display: flex; justify-content: space-between; align-items: center">
{btn("Back",prev,False)}
<span style="font-size: 13px; color: {T2}">You pay for confirmed prints, real scans and AR launches, plus commission on sales. Never for failures.</span>
{btn(nlabel,nxt)}
</div>
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
    open(P+name+'.dc.html','w').write(html)

# A4.1 Creative
msgs=you("Summer ad for our $5 combo. Bright, burger big, our logo bottom right. Use our brand guide.",("LOGO.PNG","BURGER.JPG","BRAND-GUIDE.PDF"))+\
 ai("Here are 3 directions, each made in every slot size and for box faces. I used your red and yellow from the guide and kept the logo clear of the seam.",("Make the burger bigger","Try a night version","Add Spanish"))+\
 you("Option B. Make the price larger and add 'Order from your bottle'.")+\
 ai("Updated. The QR sits in the corner of every size so scans go to your experience.",("Show on a bottle","Make 3 more"))
sizes=''.join(chip(s,i==1) for i,s in enumerate(['1/6 slot','1/3 slot','1/2 slot','Full wrap','12-pack box face','24-pack box face']))
variants=''.join(f'<div style="flex: 1 1 0; display: flex; flex-direction: column; gap: 8px">{ph("230px","OPTION "+x)}<div style="display: flex; justify-content: space-between; align-items: center"><span style="font-size: 13px; {"font-weight: 600" if x=="B" else "color: "+T2}">{"Chosen · 6 sizes ready" if x=="B" else "6 sizes"}</span><a href="#" style="font-size: 13px; font-weight: 600">{"Edit" if x=="B" else "Use this"}</a></div></div>' for x in 'ABC')
right=f'''<div style="flex: 1 1 auto; padding: 20px 32px; display: flex; flex-direction: column; gap: 16px; min-width: 0">
<div style="display: flex; justify-content: space-between; align-items: center">{lab("ARTWORK · MADE IN EVERY SIZE AUTOMATICALLY")}<a href="#" style="font-size: 13px; font-weight: 600">Or upload finished artwork</a></div>
<div style="display: flex; gap: 8px; flex-wrap: wrap">{sizes}</div>
<div style="display: flex; gap: 16px">{variants}</div>
<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
{ph("100%","ON A BOTTLE NEXT TO 2 OTHER ADS · DRAG TO TURN","; flex: 1 1 0")}
<div style="width: 300px; flex: none">{card(lab("CHECKS")+''.join(f'<div style="display: flex; justify-content: space-between; font-size: 13px"><span>{a}</span><span style="color: {T2}">{b}</span></div>' for a,b in [("Print resolution","✓ OK"),("Text readable at 1/6","✓ OK"),("QR clear of the seam","✓ OK"),("Content rules","✓ likely to pass")]))}</div>
</div></div>'''
page(0,"Creative",chatpanel("Design with the assistant","Describe the ad. Add logos, photos, videos, brand guides.",msgs,"Describe your ad or a change…","Logo · photo · video · brand kit · file · link")+right)

# A4.2 Where and who
right=f'''<div style="flex: 1 1 auto; padding: 20px 32px; display: flex; gap: 24px; min-width: 0">
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 14px; min-width: 0">
{askbar("e.g. \"People within 2 miles of our store, lunch hours, who like food\"")}
{ph("100%","MAP · MACHINES, ROUTES AND AREAS","; flex: 1 1 auto")}
</div>
<div style="width: 380px; flex: none; display: flex; flex-direction: column; gap: 12px">
{card(lab("WHERE")+'<div style="display: flex; gap: 6px; flex-wrap: wrap">'+chip("Vending machines",True)+chip("Home delivery packs",True)+chip("Events",dashed=True)+'</div><div style="font-size: 13px; color: '+T2+'">2 mi around 600 Congress Ave · 14 machines · 3 delivery routes</div>')}
{card(lab("WHO")+'<div style="display: flex; gap: 6px; flex-wrap: wrap">'+chip("Likes food",True)+chip("Ages 18+",True)+chip("Sports",dashed=True)+chip("+ Add",dashed=True)+'</div><div style="font-size: 12px; color: '+T2+'">Uses only interests people chose to share</div>')}
{card(lab("WHEN")+'<div style="display: flex; gap: 6px; flex-wrap: wrap">'+chip("Every day",True)+chip("11 am to 2 pm",True)+chip("Weekends only",dashed=True)+'</div>')}
{card(lab("ESTIMATE")+'<div style="font-size: 26px; font-weight: 600">≈ 4,200 bottles / week</div><div style="font-size: 13px; color: '+T2+'">Each one prints your ad fresh, next to up to 5 others</div>',"; background: "+G2+"; border-color: "+G2)}
</div></div>'''
page(1,"Where and who",right)

# A4.3 Scan experience
plugins=''.join(chip(x,i in (0,2)) for i,x in enumerate(["3D menu in AR","Video","Order and pay","Coupon","Directions","AI salesperson","Game","3D tour","Custom (SDK)"]))
msgs=you("When people scan, let them spin the combo in 3D, see the menu, and order for pickup.",("MENU.PDF","COMBO.MP4"))+\
 ai("Set up with 2 plug-ins: 3D menu in AR and Order and pay. I made 3D models of the combo from your photos. Should pickup go to your Congress Ave store?",("Yes, Congress Ave","Add delivery too"))+\
 you("Yes. Also give first-time scanners free fries.")+\
 ai("Added. It changes per viewer: new people see free fries, regulars see their usual order.",("Preview as a new viewer","Preview as a regular"))
right=f'''<div style="flex: 1 1 auto; padding: 20px 32px; display: flex; gap: 24px; min-width: 0">
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 14px; min-width: 0">
{lab("PLUG-INS IN USE · ADD ANY FROM THE MARKETPLACE")}
<div style="display: flex; gap: 8px; flex-wrap: wrap">{plugins}</div>
{ph("100%","AR PREVIEW · 3D COMBO ON A TABLE","; flex: 1 1 auto")}
</div>
<div style="width: 300px; flex: none; display: flex; flex-direction: column; gap: 10px; align-items: center">
{lab("SCAN PAGE · PHONE PREVIEW")}
<div style="width: 280px; flex: 1 1 auto; border: 2px solid {INK}; border-radius: 32px; padding: 18px 14px; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px">
<div style="display: flex; align-items: center; gap: 8px"><span style="width: 28px; height: 28px; border-radius: 7px; background: {G1}; border: 1px solid {B}"></span><span style="font-size: 14px; font-weight: 600">Joe's Burgers</span></div>
{ph("190px","3D COMBO")}
<div style="font-size: 15px; font-weight: 600">Free fries on your first order</div>
<div style="font-size: 12px; color: {T2}">Pickup at Congress Ave · ready in 10 min</div>
<div style="margin-top: auto; height: 40px; border-radius: 20px; background: {INK}; color: #ffffff; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600">Order now</div>
</div></div></div>'''
page(2,"Scan experience",chatpanel("Build it with the assistant","Describe what should happen when someone scans.",msgs,"Describe the experience or a change…","Menu · photo · video · 3D model · link · file")+right)

# A4.4 Budget
def opt(t,s,on,rows):
    r=''.join(f'<div style="display: flex; justify-content: space-between; font-size: 14px; border-top: 1px solid {G1}; padding-top: 10px"><span style="color: {T2}">{a}</span><span style="font-weight: 600">{b}</span></div>' for a,b in rows)
    return f'<div style="flex: 1 1 0; border: {"2px solid "+INK if on else "1px solid "+B}; border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 10px"><div style="display: flex; align-items: center; gap: 10px"><span style="width: 18px; height: 18px; border-radius: 9px; box-sizing: border-box; border: {"6px solid "+INK if on else "1px solid "+T3}"></span><span style="font-size: 17px; font-weight: 600">{t}</span></div><div style="font-size: 13px; color: {T2}">{s}</div>{r}</div>'
right=f'''<div style="flex: 1 1 auto; padding: 20px 32px; display: flex; gap: 24px; min-width: 0">
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 16px; min-width: 0">
{askbar("e.g. \"Spend about $2,000 this month, mostly weekdays\"")}
<div style="display: flex; gap: 16px">
{opt("Guaranteed","A fixed number of prints at a set price per print",True,[("Prints","20,000"),("Price per print","$ PRICE"),("Slot size","1/3")])}
{opt("Bid","Set your highest price per print; win slots as they print",False,[("Max per print","$ —"),("Daily cap","$ —"),("Slot size","Any")])}
</div>
<div style="display: flex; gap: 16px">
{card(lab("DATES")+'<div style="font-size: 15px; font-weight: 600">Jun 1 to Jun 30</div><div style="font-size: 13px; color: '+T2+'">Stops early if the prints run out</div>',"; flex: 1 1 0")}
{card(lab("SCANS AND AR")+'<div style="display: flex; justify-content: space-between; font-size: 15px; font-weight: 600"><span>Per scan</span><span>$ PRICE</span></div><div style="display: flex; justify-content: space-between; font-size: 15px; font-weight: 600"><span>Per AR launch</span><span>$ PRICE</span></div><div style="font-size: 13px; color: '+T2+'">Each one is built fresh for that viewer. Cap: $ — / day</div>',"; flex: 1 1 0")}
{card(lab("SALES")+'<div style="display: flex; justify-content: space-between; font-size: 15px; font-weight: 600"><span>Commission</span><span>% RATE</span></div><div style="font-size: 13px; color: '+T2+'">On each purchase made from your bottle\'s scan or AR. Refunds reverse it.</div>',"; flex: 1 1 0")}
</div></div>
<div style="width: 340px; flex: none">{card(lab("SUMMARY")+''.join(f'<div style="display: flex; justify-content: space-between; font-size: 14px"><span style="color: {T2}">{a}</span><span style="font-weight: 600">{b}</span></div>' for a,b in [("20,000 prints","$ PRINTS"),("≈ 2,400 scans","$ SCANS"),("≈ 900 AR launches","$ AR"),("Total, max","$ TOTAL"),("Plus commission on sales","% RATE")])+f'<div style="font-size: 12px; line-height: 17px; color: {T2}; border-top: 1px solid {G1}; padding-top: 10px">Scans and AR launches count only when they load; repeats from one person in a short time and bots are free. Commission is charged only on completed sales. Every charge is in the open ledger.</div>',"; background: "+G2+"; border-color: "+G2)}</div>
</div>'''
page(3,"Budget and price",right)

# A4.5 Review
checks=''.join(f'<div style="display: flex; justify-content: space-between; align-items: center; font-size: 14px; border-top: 1px solid {G1}; padding-top: 10px"><span>✓ {a}</span><a href="{h}" style="font-size: 13px; font-weight: 600">Edit</a></div>' for a,h in [("Creative · option B, 6 sizes","AdCreative.dc.html"),("14 machines, 3 routes · lunch hours","AdWhere.dc.html"),("3D menu in AR + order and pay","AdScan.dc.html"),("20,000 prints + scans, AR, commission · Jun 1–30","AdBudget.dc.html")])
right=f'''<div style="flex: 1 1 auto; padding: 20px 32px; display: flex; gap: 24px; min-width: 0">
<div style="flex: 1 1 auto; display: flex; flex-direction: column; gap: 14px; min-width: 0">
<div style="display: flex; gap: 8px">{chip("On a bottle",True)}{chip("On a 12-pack box")}{chip("Scan page")}{chip("AR")}</div>
{ph("100%","FULL PREVIEW · YOUR AD ON A REAL BOTTLE NEXT TO OTHER ADS","; flex: 1 1 auto")}
</div>
<div style="width: 380px; flex: none; display: flex; flex-direction: column; gap: 12px">
{card(lab("CHECKLIST")+checks)}
{card(lab("WHAT HAPPENS NEXT")+f'<div style="font-size: 14px; line-height: 20px">1. Content review, usually within a day<br>2. Your ad starts printing on the start date<br>3. Live prints, scans and orders on your overview</div>')}
{card(f'<div style="font-size: 13px; line-height: 19px; color: {T2}">You own this ad\'s QR and AR on every bottle it prints on. You pay per confirmed print, scan and AR launch, plus commission on sales.</div>',"; background: "+G2+"; border-color: "+G2)}
</div></div>'''
page(4,"Review and launch",right)

# A2 Overview
def overview():
    side=''.join(f'<a href="{ {"Overview":"AdOverview.dc.html","Campaigns":"AdCreative.dc.html"}.get(n,"#") }" style="padding: 9px 12px; border-radius: 8px; font-size: 14px; text-decoration: none; {"background: "+G1+"; font-weight: 600" if n=="Overview" else "color: "+T2}">{n}</a>' for n in ['Overview','Campaigns','Creative library','Reports','Billing'])
    kpis=''.join(f'<div style="flex: 1 1 0; background: {G2}; border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px"><div style="font-size: 12px; color: {T2}">{a}</div><div style="font-size: 24px; font-weight: 600">{b}</div><div style="font-size: 12px; color: {T2}">{c}</div></div>' for a,b,c in [("Prints","4,180","on 4,180 bottles"),("Scans","512","12.2% of prints"),("AR launches","196","38% of scans"),("Purchases","141","from scans and AR"),("Your sales","$1,410","made from bottles"),("Spent","$ TOTAL","prints, scans, AR, commission")])
    funnel=''.join(f'<div style="display: flex; align-items: center; gap: 10px"><span style="width: 90px; font-size: 13px; color: {T2}">{a}</span><span style="flex: 1 1 auto; height: 22px; background: {G1}; border-radius: 4px"><span style="display: block; width: {w}%; height: 22px; background: {INK}; border-radius: 4px"></span></span><span style="width: 52px; text-align: right; font-size: 13px; font-weight: 600">{b}</span></div>' for a,b,w in [("Prints","4,180",100),("Scans","512",12.2),("AR launches","196",4.7),("Purchases","141",3.4)])
    bars=''.join(f'<div style="flex: 1 1 0; display: flex; flex-direction: column; align-items: center; gap: 4px; justify-content: flex-end; height: 100%"><span style="width: 100%; height: {h}%; background: {INK if i==6 else T3}; border-radius: 3px 3px 0 0"></span><span style="font-size: 11px; color: {T2}">{d}</span></div>' for i,(d,h) in enumerate(zip(["M","T","W","T","F","S","S"],[48,55,52,60,78,92,70])))
    spend=''.join(f'<div style="display: flex; justify-content: space-between; font-size: 14px; {"border-top: 1px solid "+B+"; padding-top: 8px; font-weight: 600" if a=="Total" else ""}"><span style="color: {INK if a=="Total" else T2}">{a}</span><span style="font-weight: 600">{b}</span></div>' for a,b in [("4,180 prints","$ —"),("512 scans","$ —"),("196 AR launches","$ —"),("Commission on $1,410","$ —"),("Total","$ TOTAL")])
    rows=[("ATX-014 · Congress Ave","Machine","1,240","212","88","61","$ —"),("Route 3 · Travis Heights","12-packs","960","118","41","29","$ —"),("ATX-022 · Rainey St","Machine","880","96","35","24","$ —"),("Route 7 · Mueller","24-packs","640","52","18","15","$ —"),("ATX-031 · East 6th","Machine","460","34","14","12","$ —")]
    th=''.join(f'<th style="text-align: {"left" if i<2 else "right"}; font-size: 12px; font-weight: 600; color: {T2}; padding: 8px 10px; border-bottom: 1px solid {B}">{h}</th>' for i,h in enumerate(["Place","Type","Prints","Scans","AR","Sales","Cost per sale"]))
    tr=''.join('<tr>'+''.join(f'<td style="text-align: {"left" if i<2 else "right"}; font-size: 13px; padding: 8px 10px; border-bottom: 1px solid {G1}; {"font-weight: 600" if i==0 else ("color: "+T2 if i==1 else "")}">{c}</td>' for i,c in enumerate(r))+'</tr>' for r in rows)
    camps=''.join(f'<div style="display: flex; align-items: center; gap: 12px; border-top: 1px solid {G1}; padding-top: 10px"><span style="width: 36px; height: 36px; border-radius: 8px; background: {G1}; border: 1px solid {B}; flex: none"></span><span style="display: flex; flex-direction: column; flex: 1 1 auto"><span style="font-size: 14px; font-weight: 600">{a}</span><span style="font-size: 12px; color: {T2}">{b}</span></span><span style="font-size: 12px; padding: 3px 8px; border-radius: 10px; {"background: "+INK+"; color: #fff" if c=="Live" else "border: 1px solid "+B}">{c}</span><a href="#" style="font-size: 13px; font-weight: 600">{d}</a></div>' for a,b,c,d in [("Summer $5 combo","3,120 of 20,000 prints · ends Jun 30","Live","Pause"),("Free fries for new scanners","1,060 of 5,000 prints · ends Jun 15","Live","Pause"),("Fall menu","In content review","Review","View")])
    html=f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>A2 Overview</title>
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
<div style="width: 220px; flex: none; border-right: 1px solid {B}; padding: 22px 14px; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px">
<div style="font-size: 20px; font-weight: 600; padding: 0 12px 4px">freewater</div>
<div style="{MONO}; font-size: 10px; letter-spacing: 0.12em; color: {T2}; padding: 0 12px 16px">ADVERTISER · WHITE-LABEL READY</div>
{side}
<div style="margin-top: auto; display: flex; align-items: center; gap: 10px; padding: 0 12px"><span style="width: 32px; height: 32px; border-radius: 8px; background: {G1}; border: 1px solid {B}"></span><span style="display: flex; flex-direction: column"><span style="font-size: 13px; font-weight: 600">Joe's Burgers</span><span style="font-size: 12px; color: {T2}">Austin, TX</span></span></div>
</div>
<div style="flex: 1 1 auto; min-width: 0; padding: 20px 32px 24px; display: flex; flex-direction: column; gap: 14px; box-sizing: border-box">
<div style="display: flex; justify-content: space-between; align-items: center">
<div style="display: flex; align-items: center; gap: 14px"><div style="font-size: 22px; font-weight: 600">Overview</div><span style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: {T2}"><span style="width: 8px; height: 8px; border-radius: 4px; background: {INK}"></span>Live · last print 4 s ago at ATX-014</span></div>
<div style="display: flex; align-items: center; gap: 8px">{chip("Last 7 days",True)}{chip("All campaigns")}{btn("New campaign","AdCreative.dc.html",True,40)}</div>
</div>
<div style="display: flex; flex-direction: column; gap: 6px">
{askbar("Which machine drove the most burger orders?")}
<div style="font-size: 13px; color: {T2}; padding-left: 16px"><b style="color: {INK}">Answer:</b> ATX-014 on Congress Ave, 61 orders (43%), mostly 12 to 1 pm. <a href="#" style="font-weight: 600">Show on map</a> · <a href="#" style="font-weight: 600">Put more budget there</a></div>
</div>
<div style="display: flex; gap: 12px">{kpis}</div>
<div style="display: flex; gap: 16px; height: 230px; flex: none">
{card(lab("FROM BOTTLE TO SALE")+f'<div style="display: flex; flex-direction: column; gap: 12px; flex: 1 1 auto; justify-content: center">{funnel}</div>',"; flex: 1 1 0")}
{card(f'<div style="display: flex; justify-content: space-between">{lab("SCANS BY DAY")}<span style="font-size: 12px; color: {T2}">Switch: prints · scans · AR · sales</span></div><div style="display: flex; gap: 10px; align-items: flex-end; flex: 1 1 auto; min-height: 0">{bars}</div>',"; flex: 1 1 0")}
{card(lab("WHAT YOU PAID")+spend+f'<a href="#" style="font-size: 13px; font-weight: 600; margin-top: auto">See every charge in the open ledger</a>',"; width: 320px; flex: none; box-sizing: border-box")}
</div>
<div style="display: flex; gap: 16px; flex: 1 1 auto; min-height: 0">
{card(f'<div style="display: flex; justify-content: space-between">{lab("TOP PLACES")}<a href="#" style="font-size: 13px; font-weight: 600">Full report</a></div><table style="border-collapse: collapse; width: 100%"><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table>',"; flex: 1 1 auto; min-width: 0")}
{card(f'<div style="display: flex; justify-content: space-between">{lab("CAMPAIGNS")}<a href="#" style="font-size: 13px; font-weight: 600">All</a></div>{camps}',"; width: 420px; flex: none; box-sizing: border-box")}
</div>
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
    open(P+'AdOverview.dc.html','w').write(html)
overview()
