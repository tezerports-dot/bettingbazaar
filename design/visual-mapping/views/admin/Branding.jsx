import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function Branding() {
  return <AdminPanelShell title={'Branding'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Branding"><p>API binding: <code>/api/admin/branding</code></p></VisualPage></AdminPanelShell>;
}
