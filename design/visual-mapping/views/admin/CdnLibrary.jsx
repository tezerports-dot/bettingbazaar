import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function CdnLibrary() {
  return <AdminPanelShell title={'CDN Library'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="CDN Library"><p>API binding: <code>/api/admin/branding/images</code></p></VisualPage></AdminPanelShell>;
}
