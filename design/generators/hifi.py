import sys,json
P=sys.argv[1]
NAVY='#000000';SKY='#7FC6EA';DSKY='#1E7DB8';ICE='#EEF6FB';CAN='#D9E0E7';SUB='#5A6B80';LINE='#DCE5EE';WHITE='#FFFFFF'
H="font-family: Comfortaa, 'Arial Rounded MT Bold', sans-serif"
B="font-family: 'DM Sans', 'Helvetica Neue', sans-serif"
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&amp;family=Comfortaa:wght@300;700&amp;display=swap">
<style>
body{{margin:0}}
a{{color:inherit}}
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

_bid=[0]
def bottle(w=120,variant='ads'):
    _bid[0]+=1;i=_bid[0];h=w*2.5
    if variant=='ads':
        label=f'''<rect x="0" y="105" width="34" height="160" fill="#4A2A1A"/><text x="17" y="150" font-family="Comfortaa" font-weight="900" font-size="9" fill="#F6E3C8" text-anchor="middle">LUMA</text><circle cx="17" cy="200" r="11" fill="#F6E3C8"/><rect x="34" y="105" width="56" height="160" fill="#D7262E"/><text x="62" y="128" font-family="Comfortaa" font-weight="900" font-size="15" fill="#FFC93C" text-anchor="middle">JOE&#39;S</text><text x="62" y="140" font-family="DM Sans" font-weight="700" font-size="7" fill="#fff" text-anchor="middle">BURGERS</text><ellipse cx="62" cy="178" rx="20" ry="7" fill="#F2A33A"/><rect x="42" y="181" width="40" height="7" rx="3" fill="#5B2A12"/><rect x="43" y="188" width="38" height="4" fill="#7DBA4A"/><ellipse cx="62" cy="196" rx="20" ry="6" fill="#F2A33A"/><text x="62" y="226" font-family="Comfortaa" font-weight="900" font-size="16" fill="#fff" text-anchor="middle">$5</text><text x="62" y="237" font-family="DM Sans" font-weight="700" font-size="6.5" fill="#fff" text-anchor="middle">COMBO</text><rect x="52" y="244" width="20" height="14" fill="#fff"/><rect x="54" y="246" width="4" height="4" fill="#111"/><rect x="66" y="246" width="4" height="4" fill="#111"/><rect x="54" y="252" width="4" height="4" fill="#111"/><rect x="60" y="249" width="3" height="3" fill="#111"/><rect x="90" y="105" width="30" height="160" fill="#000"/><text x="105" y="128" font-family="Comfortaa" font-weight="300" font-size="9" fill="#fff" text-anchor="middle">free</text><text x="105" y="138" font-family="Comfortaa" font-weight="700" font-size="8.5" fill="#7FC6EA" text-anchor="middle">water</text><rect x="97" y="200" width="16" height="16" fill="#fff"/><rect x="99" y="202" width="4" height="4" fill="#000"/><rect x="107" y="202" width="4" height="4" fill="#000"/><rect x="99" y="210" width="4" height="4" fill="#000"/><text x="105" y="232" font-family="DM Sans" font-size="4" fill="#ddd" text-anchor="middle">SPRING WATER</text><text x="105" y="238" font-family="DM Sans" font-size="4" fill="#ddd" text-anchor="middle">16 fl oz</text>'''
    elif variant=='maya':
        label=f'''<rect x="0" y="105" width="120" height="160" fill="#F7C6D4"/><circle cx="60" cy="170" r="30" fill="#E9A6BA"/><circle cx="60" cy="160" r="11" fill="#C98A73"/><path d="M40 196 Q60 176 80 196 Z" fill="#C98A73"/><text x="60" y="224" font-family="Comfortaa" font-weight="900" font-size="14" fill="#B8862E" text-anchor="middle">Maya</text><text x="60" y="240" font-family="Comfortaa" font-weight="300" font-size="10" fill="#B8862E" text-anchor="middle">turns 30</text><circle cx="22" cy="130" r="3" fill="#D9AE4A"/><circle cx="98" cy="142" r="2.5" fill="#D9AE4A"/><circle cx="92" cy="246" r="3" fill="#D9AE4A"/><circle cx="26" cy="250" r="2" fill="#D9AE4A"/>'''
    else:
        label=f'<rect x="0" y="105" width="120" height="160" fill="{NAVY}"/>'
    return f'''<svg width="{w}" height="{h:.0f}" viewBox="0 0 120 300" role="img" aria-label="FreeWater aluminum bottle with a printed label"><defs>
<linearGradient id="m{i}" x1="0" x2="1"><stop offset="0" stop-color="#8E99A5"/><stop offset=".28" stop-color="#F4F7FA"/><stop offset=".55" stop-color="#C5CED8"/><stop offset="1" stop-color="#7D8894"/></linearGradient>
<linearGradient id="s{i}" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".38"/><stop offset=".25" stop-color="#fff" stop-opacity=".28"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/><stop offset=".8" stop-color="#000" stop-opacity=".12"/><stop offset="1" stop-color="#000" stop-opacity=".42"/></linearGradient>
<clipPath id="c{i}"><path d="M46 22 L74 22 L74 40 C74 60 110 70 110 95 L110 285 Q110 298 97 298 L23 298 Q10 298 10 285 L10 95 C10 70 46 60 46 40 Z"/></clipPath></defs>
<rect x="42" y="2" width="36" height="22" rx="4" fill="{NAVY}"/><rect x="42" y="18" width="36" height="5" fill="#1A1A1A"/>
<path d="M46 22 L74 22 L74 40 C74 60 110 70 110 95 L110 285 Q110 298 97 298 L23 298 Q10 298 10 285 L10 95 C10 70 46 60 46 40 Z" fill="url(#m{i})"/>
<g clip-path="url(#c{i})"><g transform="translate(10 0) scale(.8333 1)">{label}</g><rect x="0" y="0" width="120" height="300" fill="url(#s{i})"/></g></svg>'''

ICON={
'scan':'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M9 9h6v6H9z"/></svg>',
'home':'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/></svg>',
'pin':'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
'saved':'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 4h12v17l-6-4-6 4z"/></svg>',
'me':'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
'truck':'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M2 6h12v10H2zM14 10h4l3 3v3h-7z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
'back':'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>',
'plus':'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
'mic':'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
'up':'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
'cube':'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>',
}
def tabbar(active):
    def t(k,label,href):
        on=k==active
        return f'<a href="{href}" style="display: flex; flex-direction: column; align-items: center; gap: 3px; min-height: 44px; text-decoration: none; font-size: 11px; font-weight: {700 if on else 500}; color: {NAVY if on else "#8A99AB"}">{ICON[k]}{label}</a>'
    return f'''<div style="border-top: 1px solid {LINE}; background: {WHITE}; padding: 8px 16px 24px; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); align-items: end; {B}">
{t("home","Home","HfHome.dc.html")}{t("pin","Machines","WireMap.dc.html")}
<a href="HfScan.dc.html" aria-label="Scan a bottle" style="display: flex; flex-direction: column; align-items: center; gap: 3px; margin-top: -30px; text-decoration: none; font-size: 11px; font-weight: 700; color: {NAVY}"><span style="width: 60px; height: 60px; border-radius: 30px; background: {SKY}; color: {NAVY}; display: flex; align-items: center; justify-content: center; border: 5px solid {WHITE}; box-shadow: 0 6px 16px rgba(15,39,66,.22)">{ICON["scan"]}</span>Scan</a>
{t("saved","Saved","#")}{t("me","Me","#")}</div>'''
def phone(inner,bg=WHITE):
    return f'<div style="width: 390px; height: 844px; box-sizing: border-box; background: {bg}; {B}; color: {NAVY}; display: flex; flex-direction: column; overflow: hidden">{inner}</div>'

# ---------- C4 Home ----------
saved=''.join(f'<a href="#" style="flex: 0 0 132px; border-radius: 16px; overflow: hidden; text-decoration: none; background: {WHITE}; border: 1px solid {LINE}"><div style="height: 70px; background: {bg}; display: flex; align-items: flex-end; padding: 8px 10px; box-sizing: border-box; {H}; font-weight: 700; font-size: 15px; color: {fg}">{brand}</div><div style="padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 1px"><span style="font-size: 13px; font-weight: 700; color: {NAVY}">{t}</span><span style="font-size: 11px; color: {SUB}">{k}</span></div></a>' for bg,fg,brand,t,k in [("#D7262E","#FFC93C","Joe&#39;s","Free fries","Offer, ends Sunday"),("#F1EEE6","#1B1B1B","Austin Daily","Rail line opens","News story"),("#2F6B4F","#E8F1EA","Maple Realty","1406 Maple St","3D home tour")])
inner=f'''<div style="flex: 1 1 auto; padding: 50px 20px 12px; display: flex; flex-direction: column; gap: 14px; background: linear-gradient(180deg, {ICE} 0, {WHITE} 300px)">
<div style="display: flex; align-items: center; justify-content: space-between"><span style="{H}; display: flex; flex-direction: column; line-height: .9" aria-label="FreeWater"><span style="font-weight: 300; font-size: 24px">free</span><span style="font-weight: 700; font-size: 24px; color: {SKY}">water</span></span><a href="#" aria-label="Your profile" style="width: 40px; height: 40px; border-radius: 20px; background: {CAN}; display: flex; align-items: center; justify-content: center; color: {NAVY}; text-decoration: none; font-weight: 700; font-size: 14px">JS</a></div>
<div style="background: {NAVY}; border-radius: 22px; padding: 18px 20px; color: {WHITE}; display: flex; flex-direction: column; gap: 14px">
<div style="{H}; line-height: 1.1"><div style="font-weight: 700; font-size: 26px">Save money.</div><div style="font-weight: 300; font-size: 26px; color: {SKY}">Drink FreeWater.</div></div>
<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px">{''.join(f'<div style="display: flex; flex-direction: column"><span style="{H}; font-weight: 700; font-size: 22px">{a}</span><span style="font-size: 12px; color: #A7B4BF">{b}</span></div>' for a,b in [("125","bottles"),("$12.50","to charity"),("$125","saved")])}</div></div>
<a href="HfScan.dc.html" style="display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-radius: 18px; background: {SKY}; color: {NAVY}; text-decoration: none"><span style="width: 44px; height: 44px; border-radius: 12px; background: {WHITE}; display: flex; align-items: center; justify-content: center">{ICON["scan"]}</span><span style="display: flex; flex-direction: column; flex: 1 1 auto"><span style="font-size: 17px; font-weight: 700">Scan a bottle</span><span style="font-size: 13px; color: #0E3B57">Open the AR printed on any FreeWater</span></span></a>
<div style="border: 1px solid {LINE}; border-radius: 18px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; background: {WHITE}">
<div style="display: flex; gap: 12px; align-items: center"><span style="width: 44px; height: 44px; border-radius: 12px; background: {ICE}; color: {DSKY}; display: flex; align-items: center; justify-content: center; flex: none">{ICON["truck"]}</span><span style="display: flex; flex-direction: column; flex: 1 1 auto"><span style="font-size: 16px; font-weight: 700">Your 12-pack arrives Tuesday</span><span style="font-size: 13px; color: {SUB}">Printed for you Monday night. Leave your empties out.</span></span></div>
<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px"><a href="#" style="height: 42px; border-radius: 21px; background: {NAVY}; color: {WHITE}; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; text-decoration: none">Manage delivery</a><a href="#" style="height: 42px; border-radius: 21px; border: 1.5px solid {NAVY}; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; text-decoration: none">Change pack size</a></div></div>
<a href="WireOrder.dc.html" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-radius: 16px; background: {ICE}; text-decoration: none"><span style="display: flex; flex-direction: column"><span style="font-size: 15px; font-weight: 700">ATX-014 on Congress Ave</span><span style="font-size: 13px; color: {SUB}">0.2 miles away, 252 bottles in stock</span></span><span style="font-size: 14px; font-weight: 700; color: {DSKY}">Get one</span></a>
<div style="display: flex; flex-direction: column; gap: 8px"><div style="display: flex; justify-content: space-between; align-items: baseline"><span style="font-size: 16px; font-weight: 700">Saved from your scans</span><a href="#" style="font-size: 13px; font-weight: 700; color: {DSKY}; text-decoration: none">See all</a></div>
<div style="display: flex; gap: 10px; margin-right: -20px; overflow: hidden">{saved}</div></div>
</div>{tabbar("home")}'''
write('HfHome','C4 Home · hi-fi',390,844,phone(inner))

# ---------- C6 Order ----------
inner=f'''<div style="flex: 1 1 auto; display: flex; flex-direction: column; background: {WHITE}">
<div style="position: relative; height: 430px; background: radial-gradient(120% 80% at 50% 30%, {WHITE} 0, {ICE} 55%, #D6ECFA 100%); display: flex; flex-direction: column; align-items: center; padding-top: 50px; box-sizing: border-box">
<div style="position: absolute; left: 20px; right: 20px; top: 50px; display: flex; align-items: center; gap: 12px"><a href="WireMap.dc.html" aria-label="Back to machines" style="width: 44px; height: 44px; border-radius: 22px; background: {WHITE}; display: flex; align-items: center; justify-content: center; color: {NAVY}; box-shadow: 0 2px 8px rgba(15,39,66,.08)">{ICON["back"]}</a><span style="display: flex; flex-direction: column"><span style="font-size: 15px; font-weight: 700">ATX-014</span><span style="font-size: 12px; color: {SUB}">Congress Ave, 12 ft away</span></span></div>
<div style="margin-top: 52px; filter: drop-shadow(0 18px 18px rgba(15,39,66,.25))">{bottle(104)}</div>
<div style="position: absolute; bottom: 14px; font-size: 12px; color: {SUB}">Sample label. Yours prints fresh with different ads.</div></div>
<div style="flex: 1 1 auto; padding: 20px 20px 26px; display: flex; flex-direction: column; gap: 10px">
<div style="{H}; font-weight: 700; font-size: 30px; line-height: 1.05">Free spring water</div>
<div style="font-size: 15px; color: {SUB}; line-height: 1.45">16 oz aluminum bottle, ready in about 30 seconds. Ads pay for it, and 10¢ goes to Austin Parks Foundation.</div>
<div style="margin-top: auto; display: flex; flex-direction: column; gap: 10px">
<a href="HfCountdown.dc.html" style="height: 58px; border-radius: 29px; background: {NAVY}; color: {WHITE}; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700; text-decoration: none">Get my free water</a>
<a href="HfDesign.dc.html" style="height: 46px; border-radius: 23px; border: 1.5px solid {LINE}; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; text-decoration: none">Design my own bottle</a>
<span style="font-size: 12px; color: {SUB}; text-align: center">Your own design is paid and ad-free</span></div></div></div>'''
write('HfOrder','C6 Order · hi-fi',390,844,phone(inner))

# ---------- C6.1 Countdown ----------
r=58;circ=2*3.14159*r;done=0.2
inner=f'''<div style="flex: 1 1 auto; padding: 56px 20px 26px; display: flex; flex-direction: column; gap: 18px; background: {NAVY}; color: {WHITE}">
<div style="display: flex; align-items: center; gap: 18px">
<svg width="132" height="132" viewBox="0 0 132 132" role="img" aria-label="24 seconds left"><circle cx="66" cy="66" r="{r}" fill="none" stroke="#2A2F33" stroke-width="10"/><circle cx="66" cy="66" r="{r}" fill="none" stroke="{SKY}" stroke-width="10" stroke-linecap="round" stroke-dasharray="{circ*done:.1f} {circ:.1f}" transform="rotate(-90 66 66)"/><text x="66" y="76" text-anchor="middle" font-family="Comfortaa" font-weight="700" font-size="40" fill="#fff">24</text></svg>
<div style="display: flex; flex-direction: column; gap: 4px"><span style="{H}; font-weight: 700; font-size: 24px; line-height: 1.1">Your bottle is printing</span><span style="font-size: 14px; color: #A7B4BF">It drops into the tray in 24 seconds</span></div></div>
<div style="flex: 1 1 auto; border-radius: 22px; overflow: hidden; background: linear-gradient(170deg, #6B3A22 0, #3A1D10 70%); display: flex; flex-direction: column; justify-content: space-between; padding: 18px; position: relative">
<div style="display: flex; justify-content: space-between; align-items: center"><span style="{H}; font-weight: 700; font-size: 22px; color: #F6E3C8">luma</span><span style="font-size: 11px; color: #E9CFAE; border: 1px solid rgba(233,207,174,.5); border-radius: 10px; padding: 2px 8px">Ad</span></div>
<svg style="align-self: center" width="190" height="170" viewBox="0 0 190 170" role="img" aria-label="Oat latte seen from above"><defs><radialGradient id="lat" cx=".45" cy=".4" r=".6"><stop offset="0" stop-color="#E9C9A0"/><stop offset=".7" stop-color="#B9814F"/><stop offset="1" stop-color="#8A552E"/></radialGradient></defs><ellipse cx="95" cy="92" rx="88" ry="72" fill="#000" opacity=".25"/><ellipse cx="95" cy="85" rx="86" ry="70" fill="#F4EDE3"/><path d="M168 70 q22 6 18 22 q-4 14 -22 8" fill="none" stroke="#F4EDE3" stroke-width="10"/><circle cx="95" cy="80" r="58" fill="#FBF7F1"/><circle cx="95" cy="80" r="50" fill="url(#lat)"/><path d="M95 112 C70 92 66 70 82 62 C90 58 95 64 95 70 C95 64 100 58 108 62 C124 70 120 92 95 112 Z" fill="#F7E9D5"/><path d="M95 104 C80 90 78 76 87 72 M95 104 C110 90 112 76 103 72" fill="none" stroke="#C99766" stroke-width="2"/></svg>
<div style="display: flex; flex-direction: column; gap: 6px"><span style="{H}; font-weight: 700; font-size: 28px; color: #FBE9D0; line-height: 1.05">Oat latte, on us</span><span style="font-size: 14px; color: #E9CFAE">Show this at Luma on Congress Ave before 11 am.</span>
<a href="#" style="margin-top: 8px; height: 46px; border-radius: 23px; background: #F6E3C8; color: #3A1D10; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; text-decoration: none">Save this offer</a></div></div>
<div style="display: flex; flex-direction: column; gap: 6px"><div style="display: flex; justify-content: space-between; font-size: 13px; color: #A7B4BF"><span>Printing 3 ads on your label</span><span>20%</span></div><div style="height: 6px; border-radius: 3px; background: #2A2F33"><div style="width: 20%; height: 6px; border-radius: 3px; background: {SKY}"></div></div></div>
<a href="HfScan.dc.html" style="height: 54px; border-radius: 27px; border: 2px solid {SKY}; color: {WHITE}; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; text-decoration: none">Got it? Scan your bottle</a></div>'''
write('HfCountdown','C6.1 Countdown · hi-fi',390,844,phone(inner,NAVY))

# ---------- C1 Scan (Joe's page) ----------
RED='#D7262E';YEL='#FFC93C'
burger=f'''<svg width="220" height="170" viewBox="0 0 220 170" role="img" aria-label="3D burger preview"><ellipse cx="110" cy="158" rx="88" ry="10" fill="#000" opacity=".25"/><path d="M28 78 Q110 -6 192 78 Z" fill="#F2A33A"/><ellipse cx="80" cy="44" rx="4" ry="2.4" fill="#FFE8B0"/><ellipse cx="110" cy="34" rx="4" ry="2.4" fill="#FFE8B0"/><ellipse cx="140" cy="46" rx="4" ry="2.4" fill="#FFE8B0"/><path d="M22 84 Q60 96 110 86 Q160 96 198 84 L194 96 Q110 108 26 96 Z" fill="#7DBA4A"/><rect x="26" y="96" width="168" height="10" rx="5" fill="#FFC93C"/><rect x="24" y="104" width="172" height="24" rx="12" fill="#5B2A12"/><path d="M28 130 L192 130 Q192 152 110 152 Q28 152 28 130 Z" fill="#E58E2C"/></svg>'''
inner=f'''<div style="flex: 1 1 auto; display: flex; flex-direction: column; background: {WHITE}">
<div style="background: {RED}; color: {WHITE}; padding: 50px 20px 18px; display: flex; flex-direction: column; gap: 14px; position: relative">
<div style="display: flex; align-items: center; justify-content: space-between"><span style="display: flex; flex-direction: column"><span style="{H}; font-weight: 700; font-size: 26px; color: {YEL}; line-height: 1">JOE&#39;S</span><span style="font-size: 11px; font-weight: 700; letter-spacing: .08em">BURGERS</span></span><span style="font-size: 12px; color: #FFD9D9">From the ad on your bottle</span></div>
<div style="height: 220px; border-radius: 20px; background: radial-gradient(90% 70% at 50% 40%, #E8453E 0, #A8141B 100%); display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative">{burger}
<span style="position: absolute; top: 12px; left: 12px; font-size: 12px; background: rgba(0,0,0,.22); padding: 4px 10px; border-radius: 12px">Drag to spin</span></div>
<a href="#" style="height: 50px; border-radius: 25px; background: {WHITE}; color: {RED}; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 16px; font-weight: 700; text-decoration: none">{ICON["cube"]}See it on your table</a></div>
<div style="flex: 1 1 auto; padding: 18px 20px 20px; display: flex; flex-direction: column; gap: 12px">
<div style="display: flex; flex-direction: column; gap: 4px"><span style="{H}; font-weight: 700; font-size: 26px; line-height: 1.1">Free fries on your first order</span><span style="font-size: 14px; color: {SUB}; line-height: 1.45">$5 combo: burger, fries and a drink. Pickup at Congress Ave, ready in 10 minutes.</span></div>
<a href="#" style="height: 54px; border-radius: 27px; background: {RED}; color: {WHITE}; display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 700; text-decoration: none">Order for pickup</a>
<div style="margin-top: auto; border-top: 1px solid {LINE}; padding-top: 12px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: {SUB}"><span>This bottle has 3 ads and gave 10¢</span><a href="LedgerBottle.dc.html" style="font-weight: 700; color: {DSKY}; text-decoration: none">See its receipt</a></div>
<div style="font-size: 12px; color: #8A99AB; text-align: center">Powered by <b style="color: {NAVY}">freewater</b>. No app needed.</div></div></div>'''
write('HfScan','C1 Scan page · hi-fi',390,844,phone(inner))

# ---------- C8 Design ----------
chips=''.join(f'<span style="padding: 5px 11px; border-radius: 14px; font-size: 12px; font-weight: 700; {s}">{t}</span>' for t,s in [("Label",f"background: {NAVY}; color: #fff"),("Text",f"background: {NAVY}; color: #fff"),("Scan page",f"background: {NAVY}; color: #fff"),("AR",f"border: 1.5px solid {NAVY}"),("Box",f"border: 1.5px dashed {LINE}; color: {SUB}")])
inner=f'''<div style="flex: 1 1 auto; display: flex; flex-direction: column; background: {WHITE}">
<div style="padding: 50px 20px 0; display: flex; align-items: center; gap: 12px"><a href="HfOrder.dc.html" aria-label="Back" style="width: 44px; height: 44px; border-radius: 22px; background: {ICE}; display: flex; align-items: center; justify-content: center; color: {NAVY}">{ICON["back"]}</a><span style="display: flex; flex-direction: column"><span style="font-size: 17px; font-weight: 700">Design my bottle</span><span style="font-size: 12px; color: {SUB}">Describe it. Add photos and videos.</span></span></div>
<div style="margin: 12px 20px 0; height: 190px; border-radius: 20px; background: radial-gradient(100% 90% at 50% 20%, #FFF4F7 0, #FADDE6 100%); display: flex; align-items: center; justify-content: center; gap: 22px; position: relative">
<div style="filter: drop-shadow(0 12px 12px rgba(120,40,70,.22))">{bottle(64,'maya')}</div>
<div style="display: flex; flex-direction: column; gap: 6px"><span style="font-size: 12px; color: #9C5A6E">Live preview</span><span style="{H}; font-weight: 700; font-size: 18px; color: #6E2D44">12 bottles</span><span style="font-size: 12px; color: #9C5A6E">A name on each one</span></div></div>
<div style="padding: 10px 20px 0; display: flex; gap: 6px">{chips}</div>
<div style="flex: 1 1 auto; padding: 14px 20px 8px; display: flex; flex-direction: column; gap: 12px; overflow: hidden">
<div style="align-self: flex-end; max-width: 270px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end">
<div style="display: flex; gap: 6px"><span style="width: 48px; height: 48px; border-radius: 10px; background: linear-gradient(135deg, #E9A6BA, #C98A73)"></span><span style="width: 48px; height: 48px; border-radius: 10px; background: linear-gradient(135deg, #2D3E57, #6E8BB0); display: flex; align-items: center; justify-content: center; color: #fff; font-size: 14px">&#9654;</span></div>
<div style="background: {NAVY}; color: {WHITE}; border-radius: 18px 18px 4px 18px; padding: 10px 13px; font-size: 14px; line-height: 1.4">Bottles for Maya&#39;s 30th. Pink and gold, her photo on the front. When friends scan, play our video.</div></div>
<div style="max-width: 300px; display: flex; flex-direction: column; gap: 8px"><div style="font-size: 14px; line-height: 1.45">Done. Her photo is on the front with &quot;Maya turns 30&quot; in gold, and scanning plays your video. Want confetti in AR when friends point their camera?</div>
<div style="display: flex; gap: 6px"><a href="#" style="padding: 7px 13px; border-radius: 16px; background: {ICE}; color: {NAVY}; font-size: 13px; font-weight: 700; text-decoration: none">Add AR confetti</a><a href="#" style="padding: 7px 13px; border-radius: 16px; border: 1.5px solid {LINE}; font-size: 13px; font-weight: 700; text-decoration: none">3 more styles</a></div></div></div>
<div style="padding: 0 20px 24px; display: flex; flex-direction: column; gap: 10px">
<div style="border: 1.5px solid {LINE}; border-radius: 24px; padding: 6px 6px 6px 8px; display: flex; align-items: center; gap: 6px"><a href="#" aria-label="Add photo, video, file or link" style="width: 36px; height: 36px; border-radius: 18px; background: {ICE}; display: flex; align-items: center; justify-content: center; color: {NAVY}">{ICON["plus"]}</a><span style="flex: 1 1 auto; font-size: 14px; color: #8A99AB">Describe a change</span><a href="#" aria-label="Talk" style="width: 36px; height: 36px; border-radius: 18px; display: flex; align-items: center; justify-content: center; color: {SUB}">{ICON["mic"]}</a><a href="#" aria-label="Send" style="width: 36px; height: 36px; border-radius: 18px; background: {NAVY}; color: #fff; display: flex; align-items: center; justify-content: center">{ICON["up"]}</a></div>
<a href="WireProof.dc.html" style="height: 52px; border-radius: 26px; background: {SKY}; color: {NAVY}; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; text-decoration: none">Review my proof</a></div></div>'''
write('HfDesign','C8 Design my bottle · hi-fi',390,844,phone(inner))

# ---------- Style board ----------
sw=''.join(f'<div style="display: flex; flex-direction: column; gap: 8px"><div style="height: 120px; border-radius: 18px; background: {c}; {"border: 1px solid "+LINE if c in (WHITE,ICE) else ""}"></div><span style="font-size: 15px; font-weight: 700">{n}</span><span style="font-size: 13px; color: {SUB}">{c} · {u}</span></div>' for n,c,u in [("Panel black",NAVY,"the panel, text, main buttons"),("FreeWater blue",SKY,"water in the logo, scan button"),("Link blue",DSKY,"links on white"),("Ice",ICE,"quiet backgrounds"),("Can silver",CAN,"metal, avatars"),("White",WHITE,"screens")])
inner=f'''<div style="width: 1600px; height: 1000px; box-sizing: border-box; background: {WHITE}; {B}; color: {NAVY}; padding: 64px 72px; display: grid; grid-template-columns: 1fr 360px; gap: 64px">
<div style="display: flex; flex-direction: column; gap: 44px">
<div style="display: flex; flex-direction: column; gap: 14px"><div style="{H}; line-height: 1"><div style="font-weight: 700; font-size: 84px">Save money.</div><div style="font-weight: 300; font-size: 84px; color: {SKY}">Drink FreeWater.</div></div><div style="font-size: 18px; color: {SUB}; max-width: 640px; line-height: 1.5">Taken from the real label: the black FreeWater panel, the thin white free over the bold blue water, and the brushed aluminum. Comfortaa carries the logo and headlines; DM Sans does the reading.</div></div>
<div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 18px">{sw}</div>
<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 40px">
<div style="display: flex; flex-direction: column; gap: 10px"><span style="font-size: 13px; color: {SUB}">Logo and headlines, Comfortaa 700 and 300</span><span style="{H}; font-weight: 700; font-size: 36px; line-height: 1.1">Free spring water</span><span style="{H}; font-weight: 300; font-size: 28px; color: {DSKY}">printed fresh for you</span><span style="font-size: 13px; color: {SUB}; margin-top: 10px">Body, DM Sans 400, 500 and 700</span><span style="font-size: 16px; line-height: 1.5; max-width: 460px">16 oz aluminum bottle, ready in about 30 seconds. Ads pay for it, and 10¢ goes to charity.</span></div>
<div style="display: flex; flex-direction: column; gap: 12px"><span style="font-size: 13px; color: {SUB}">Buttons and chips</span>
<div style="display: flex; gap: 10px; flex-wrap: wrap"><span style="height: 52px; padding: 0 26px; border-radius: 26px; background: {NAVY}; color: #fff; display: inline-flex; align-items: center; font-weight: 700">Get my free water</span><span style="height: 52px; padding: 0 26px; border-radius: 26px; background: {SKY}; display: inline-flex; align-items: center; font-weight: 700">Scan a bottle</span><span style="height: 52px; padding: 0 26px; border-radius: 26px; border: 1.5px solid {LINE}; display: inline-flex; align-items: center; font-weight: 700">Design my own</span></div>
<div style="display: flex; gap: 8px"><span style="padding: 6px 12px; border-radius: 14px; background: {NAVY}; color: #fff; font-size: 13px; font-weight: 700">Selected</span><span style="padding: 6px 12px; border-radius: 14px; background: {ICE}; font-size: 13px; font-weight: 700">Suggestion</span><span style="padding: 6px 12px; border-radius: 14px; border: 1.5px dashed {LINE}; color: {SUB}; font-size: 13px; font-weight: 700">Not set</span></div>
<span style="font-size: 13px; color: {SUB}; margin-top: 8px">Rules</span><span style="font-size: 15px; line-height: 1.55">Black and blue are FreeWater&#39;s. On a scan page the advertiser&#39;s own colors take over, and FreeWater shrinks to one line at the bottom. A licensee swaps these six colors and the two fonts for their own.</span></div></div></div>
<div style="background: radial-gradient(100% 70% at 50% 30%, {WHITE} 0, {ICE} 60%, #D6ECFA 100%); border-radius: 32px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px"><div style="filter: drop-shadow(0 24px 24px rgba(15,39,66,.25))">{bottle(180)}</div><div style="background: #000; border-radius: 18px; padding: 18px 22px; display: flex; flex-direction: column; align-items: center; gap: 10px"><span style="{H}; display: flex; flex-direction: column; align-items: center; line-height: .9"><span style="font-weight: 300; font-size: 44px; color: #fff">free</span><span style="font-weight: 700; font-size: 42px; color: {SKY}">water</span></span><span style="font-weight: 700; font-style: italic; font-size: 15px; color: #fff; text-align: center; line-height: 1.25">PUT YOUR BRAND IN<br><span style="color: {SKY}">EVERYONE&#39;S</span> HAND!</span></div><span style="font-size: 14px; color: {SUB}; text-align: center; max-width: 240px">The logo and tagline as printed on every panel. The bottle is the hero of every screen it appears on.</span></div>
</div>'''
write('HfStyle','Style board · hi-fi',1600,1000,inner)

c=json.load(open(P+'canvas.json'))
y=14400
c['boards']['HfStyle.dc.html']={"x":0,"y":y,"w":1600,"h":1000,"title":"Style board"}
for i,(n,t) in enumerate([('HfHome','C4 · Home'),('HfOrder','C6 · Order'),('HfCountdown','C6.1 · Countdown'),('HfScan','C1 · Scan page (advertiser&#39;s colors)'.replace('&#39;',"'")),('HfDesign','C8 · Design my bottle')]):
    c['boards'][n+'.dc.html']={"x":1680+i*470,"y":y,"w":390,"h":844,"title":t,"is_interactive":True}
for n in ['HfStyle','HfHome','HfOrder','HfCountdown','HfScan','HfDesign']:
    if n+'.dc.html' not in c['order']: c['order'].append(n+'.dc.html')
c['notes']['step4']={"x":0,"y":y-300,"text":"Step 4 · High-fidelity: consumer app","kind":"title1","maxW":4000}
json.dump(c,open(P+'canvas.json','w'),indent=2)
