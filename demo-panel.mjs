// Organize the existing demo controls without replacing any input or handler.
// The asynchronous avatar loader inserts its gallery after #avatar-source;
// that source node stays inside the avatar-materials disclosure.
const create=(tag,className,text)=>{
 const element=document.createElement(tag);
 if(className)element.className=className;
 if(text!==undefined)element.textContent=text;
 return element;
};
const place=(parent,...children)=>{
 for(const child of children.flat())if(child)parent.append(child);
 return parent;
};

export function arrangeDemoPanel(pane,{demoButton,autoButton,en=false}={}){
 if(!pane||pane.dataset.demoArranged==='true')return;
 const find=selector=>pane.querySelector(selector);
 const text=(zh,english)=>en?english:zh;
 const user=find('#demo-user'),events=find('#rule-buttons'),speed=find('#demo-speed');
 const files=find('#avatar-files'),source=find('#avatar-source');
 const run=find('#scenario'),reset=find('#reset-demo'),log=find('#demo-log');
 if(!user||!events||!speed||!files||!source||!run||!reset||!log)return;
 demoButton??=find('#demo');

 function labelFor(control,labelText){
  const previous=control.previousElementSibling;
  const label=previous?.tagName==='LABEL'?previous:create('label');
  label.className='demo-label';label.htmlFor=control.id;label.textContent=labelText;
  return label;
 }
 function disclosure(label,kind){
  const details=create('details','demo-disclosure '+kind);
  const summary=create('summary','demo-summary',label);
  const body=create('div','demo-details-body');
  place(details,summary,body);
  return {details,body};
 }

 const oldBody=find('.body');
 const illustration=find('.live-rules');
 const originalRules=illustration?.closest('details');
 const description=oldBody?.querySelector('p.note:not([id])');
 const download=[...pane.querySelectorAll('button')].find(button=>/规则图.*PNG|(?:download|rules).*PNG/i.test(button.textContent));
 const downloadStatus=oldBody?.querySelector('[role="status"]');
 const galleryAfterSource=source.nextElementSibling;
 const gallery=galleryAfterSource?.tagName==='DETAILS'?galleryAfterSource:find('#avatar-gallery');

 const panel=create('div','demo-panel');
 const primary=create('div','demo-primary');
 const userField=place(create('div','demo-field'),labelFor(user,text('测试观众','Test viewer')),user);
 const speedRow=place(create('div','demo-speed-row'),labelFor(speed,text('演示速度','Demo speed')),speed);
 events.classList.add('demo-events');events.setAttribute('aria-label',text('测试互动触发','Test interaction triggers'));
 const mainActions=place(create('div','demo-main-actions'),run,reset);
 const secondaryActions=place(create('div','demo-secondary-actions'),demoButton,autoButton);
 place(primary,userField,events,speedRow,mainActions,secondaryActions);

 const materials=disclosure(text('头像素材','Avatar materials'),'demo-materials');
 place(materials.body,labelFor(files,text('导入本地头像','Import local avatars')),files,source,gallery);
 // A gallery inserted later with source.after(gallery) lands in this same body.
 source.classList.add('demo-source-note');

 const rules=disclosure(text('规则图与下载','Rules and download'),'demo-rules');
 if(description){
  description.textContent=text('礼物优先处理，未完成的普通任务保留后重打。','Gift tasks take priority; unfinished regular tasks are retained and reprinted.');
  description.classList.add('demo-rules-note');
 }
 place(rules.body,illustration,description,download,downloadStatus);
 if(download)download.classList.add('demo-download');
 if(downloadStatus)downloadStatus.classList.add('demo-download-status');

 const history=disclosure(text('演示日志','Demo log'),'demo-logbox');
 place(history.body,log);
 place(panel,primary,place(create('div','demo-utilities'),materials.details,rules.details,history.details));

 // Preserve any future controls that the old demo body may gain. Empty layout
 // wrappers and the now-redundant original rule disclosure can be removed.
 if(oldBody?.querySelector('button,input,select,textarea,a[download]'))panel.append(oldBody);
 if(originalRules?.querySelector('button,input,select,textarea,a[download]'))panel.append(originalRules);
 pane.replaceChildren(panel);
 pane.classList.add('demo-pane');pane.dataset.demoArranged='true';
 return panel;
}
