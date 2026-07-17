import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function Announcements() {
  return <AdminPanelShell title={'Announcements'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Announcements"><p>API binding: <code>/api/admin/announcements</code></p></VisualPage></AdminPanelShell>;
}
