import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function AppAssets() {
  return <AdminPanelShell title={'App Assets'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="App Assets"><p>API binding: <code>/api/admin/app-assets</code></p></VisualPage></AdminPanelShell>;
}
