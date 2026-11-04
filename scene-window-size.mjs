// Output resolution and the on-screen preview window are separate choices.
export function sceneWindowSize(orient, availableWidth=globalThis.screen?.availWidth??1280,
 availableHeight=globalThis.screen?.availHeight??800){
 const portrait=String(orient).startsWith('portrait');
 const [unitW,unitH,preferred]=portrait?[9,16,45]:[16,9,60];
 const steps=Math.max(1,Math.min(preferred,Math.floor((availableWidth-64)/unitW),Math.floor((availableHeight-64)/unitH)));
 return [unitW*steps,unitH*steps];
}
