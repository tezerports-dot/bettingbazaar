import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function SupportLinks() {
  return <AdminPanelShell title={'Support Links'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Support Links"><p>API binding: <code>/api/admin/content/support-links</code></p></VisualPage></AdminPanelShell>;
}
