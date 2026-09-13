'use strict';
// One registry shared by the two script worlds. Only these added tools get route records.
window.CifiCompanionRoutes = Object.freeze([
  {id:'sim', path:'/companion/hunters', label:'Hunters', renderer:'render', route:'sim'},
  {id:'fleet', path:'/companion/fleet', label:'Fleet', renderer:'renderFleetPage', route:'fleet'},
  {id:'ships', path:'/companion/ships', label:'Ship Setup', renderer:'renderShipSetupPage', route:'shipsetup'},
  {id:'gear', path:'/companion/gear', label:'Gear Sets', renderer:'renderGearSetsPage', route:'gearsets'},
  {id:'research', path:'/companion/research', label:'Research', renderer:'renderResearchPage', route:'research'},
  {id:'badges', path:'/companion/badges', label:'Academy Badges', renderer:'renderBadgesPage', route:'badges'},
].map(Object.freeze));
