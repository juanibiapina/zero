#!/usr/bin/env python3
"""Generate the five selected task-count icon designs from one SVG template."""
from pathlib import Path
import copy
import os
import subprocess
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parent
NS='http://www.w3.org/2000/svg'; XL='http://www.w3.org/1999/xlink'
ET.register_namespace('',NS); ET.register_namespace('xlink',XL)
q=lambda name:'{'+NS+'}'+name
states=[
 ('0-empty',0,1.0,[]),
 ('1-task',1,1.35,[500]),
 ('2-tasks',2,1.30,[415,585]),
 ('3-tasks',3,1.25,[330,500,670]),
 ('4-plus-tasks',4,1.08,[296,432,568,704]),
]
base=ET.parse(ROOT/'template.svg')
for slug,count,scale,ys in states:
 tree=copy.deepcopy(base);root=tree.getroot();defs=root.find(q('defs'))
 content=ET.SubElement(root,q('g'))
 if count==0:
  # One continuous checkmark; three material strokes share the same path.
  path='M318 500L451 633L718 365'
  shadow=ET.SubElement(content,q('g'),{'filter':'url(#metalShadow)'})
  for width,paint,dy in [(78,'metalSide',3),(76,'ringBevel',0),(66,'silverFace',0)]:
   ET.SubElement(shadow,q('path'),{'d':path,'fill':'none','stroke':f'url(#{paint})','stroke-width':str(width),'stroke-linecap':'round','stroke-linejoin':'round','transform':f'translate(0 {dy})'})
  title='Zero: clear day checkmark'
  desc='A continuous dark graphite-metal checkmark centered on a flat white circular ground.'
 else:
  content.set('transform',f'translate(512 500) scale({scale}) translate(-512 -500)')
  for y in ys:
   ET.SubElement(content,q('use'),{'{'+XL+'}href':'#taskRow','transform':f'translate(330 {y})'})
  title=f'Zero: {count if count<4 else "four or more"} available tasks'
  desc=f'{count} centered open task rows in dark graphite metal on a flat white circular ground.'
 root.find(q('title')).text=title;root.find(q('desc')).text=desc
 svg=ROOT/f'{slug}.svg';tree.write(svg,encoding='unicode',xml_declaration=True)
 svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines())+'\n')
 png=ROOT/f'{slug}.png'
 subprocess.run(['magick','-background','none',str(svg),'-strip','PNG32:'+str(png)],check=True,env={**os.environ,'MAGICK_THREAD_LIMIT':'1'})
 result=subprocess.check_output(['magick','identify','-format','%wx%h %[channels] %[pixel:p{0,0}]',str(png)],text=True)
 assert result.startswith('2048x2048 srgba') and result.endswith('srgba(0,0,0,0)'),result
 print(slug,result)

labels=['0  Clear / checkmark','1  One task','2  Two tasks','3  Three tasks','4  Four or more']
args=[]
for (slug,*_),label in zip(states,labels):args += ['-label',label,str(ROOT/f'{slug}.png')]
subprocess.run(['magick','montage','-font','DejaVu-Sans','-pointsize','22','-background','#e5e5e5','-fill','#222222',*args,'-thumbnail','400x400','-tile','3x2','-geometry','+22+22',str(ROOT/'comparison.png')],check=True,env={**os.environ,'MAGICK_THREAD_LIMIT':'1'})
print(ROOT/'comparison.png')
