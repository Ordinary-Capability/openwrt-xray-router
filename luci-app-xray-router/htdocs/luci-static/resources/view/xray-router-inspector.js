'use strict';
'require view';
'require xray-router.inspector as inspector';

// Retain bookmarked URLs; the Services menu exposes only Xray Router.
return view.extend({
	load: function() { return inspector.load(); },
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,
	render: function(data) { return inspector.render(data); }
});
