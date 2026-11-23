// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntegrationMark } from './IntegrationMark';

describe('IntegrationMark', () => {
  it('odoo shows the official logo with alt text, served from the brand public folder', () => {
    render(<IntegrationMark kind="odoo" />);
    expect(screen.getByAltText('Odoo logo').getAttribute('src')).toBe('/brand/odoo-logo.svg');
  });
  it('the webhook keeps its generic mark and is hidden from assistive tech', () => {
    const { container } = render(<IntegrationMark kind="webhook" />);
    expect(container.textContent).toBe('{ }');
    expect(container.querySelector('img')).toBeNull();
  });
});
