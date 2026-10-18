import os
_D=os.path.dirname(os.path.abspath(__file__))
src=open(_D+'/hifi.py').read()
src=src[:src.index('# ---------- C4 Home ----------')]
P='/dev/null/'
import sys; sys.argv=['x','/tmp/']
exec(src)
B_ADS_S=bottle(104,'ads'); B_ADS_L=bottle(170,'ads'); B_MAYA=bottle(64,'maya'); B_MAYA_L=bottle(124,'maya'); B_ADS_M=bottle(124,'ads')
html=open(_D+'/proto_template.html').read()
for k,v in {'%%B_ADS_S%%':B_ADS_S,'%%B_ADS_L%%':B_ADS_L,'%%B_MAYA%%':B_MAYA,'%%B_MAYA_L%%':B_MAYA_L,'%%B_ADS_M%%':B_ADS_M,
 '%%I_SCAN%%':ICON['scan'],'%%I_HOME%%':ICON['home'],'%%I_PIN%%':ICON['pin'],'%%I_SAVED%%':ICON['saved'],'%%I_ME%%':ICON['me'],'%%I_TRUCK%%':ICON['truck'],'%%I_BACK%%':ICON['back'],'%%I_PLUS%%':ICON['plus'],'%%I_MIC%%':ICON['mic'],'%%I_UP%%':ICON['up'],'%%I_CUBE%%':ICON['cube']}.items():
    html=html.replace(k,v)
open(_D+'/../proto/freewater-prototype.html','w').write(html)
print(len(html))
