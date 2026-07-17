import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function ContentSlides() {
  return <AdminPanelShell title={'Content Slides'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Content Slides"><p>API binding: <code>/api/admin/content/slides</code></p></VisualPage></AdminPanelShell>;
}
