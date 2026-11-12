/* Pure functions shared by the student UI and regression tests. */
(function(root){
'use strict';
const api={
  session(start, end, meters, newSegments){
    return {at:new Date(start).toISOString(),seconds:Math.max(0,Math.round((end-start)/1000)),meters:Math.max(0,meters),newSegments:Math.max(0,newSegments)};
  },
  goal(value){return [25,50,100,200].includes(Number(value))?Number(value):50;},
  draft({category,location,observation,request,date}){
    return 'Campus maintenance / accessibility concern\n\nLocation: '+location.trim()+'\nCategory: '+category+'\nObserved: '+date+'\n\nWhat I observed:\n'+observation.trim()+'\n\nRequested action:\n'+request.trim()+'\n\nPlease confirm the responsible office, provide a reference number, and advise on next steps.\n\nPrepared by a student using BuffPrints. This draft has not been submitted. No official verification is implied.';
  }
};
if(typeof module!=='undefined'&&module.exports) module.exports=api;
else root.RoamStudent=api;
})(typeof window!=='undefined'?window:globalThis);
