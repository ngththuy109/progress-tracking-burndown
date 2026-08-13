import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IssueKeyList, IssueLink } from './index.js';

/**
 * `IssueLink` mang link "mở ticket" của ô Signboard ra MỌI màn hình đang in mã
 * ticket. Hai điều phải chắc, y như ô Signboard:
 *   1. Có site → mã là link `/browse/<KEY>`, mở tab mới, `rel` an toàn.
 *   2. Chưa cấu hình site → chỉ `<code>` thô, KHÔNG bịa URL.
 */
describe('IssueLink', () => {
  it('có site: mã là link /browse/<KEY>, mở tab mới, rel an toàn', () => {
    render(<IssueLink issueKey="PAY-101" baseUrl="https://acme.atlassian.net" />);
    const link = screen.getByRole('link', { name: /PAY-101/ });
    expect(link.getAttribute('href')).toBe('https://acme.atlassian.net/browse/PAY-101');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('chưa cấu hình site (baseUrl rỗng): chỉ hiện mã, KHÔNG có link', () => {
    render(<IssueLink issueKey="PAY-101" baseUrl="" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('PAY-101')).toBeTruthy();
  });

  it('mã hoá ký tự lạ trong key (khớp jiraIssueUrl)', () => {
    render(<IssueLink issueKey="A B/1" baseUrl="https://acme.atlassian.net" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      'https://acme.atlassian.net/browse/A%20B%2F1',
    );
  });
});

describe('IssueKeyList', () => {
  it('mỗi mã là một link riêng, mở đúng ticket của nó', () => {
    render(<IssueKeyList issueKeys={['PAY-13', 'PAY-14']} baseUrl="https://acme.atlassian.net" />);
    expect(screen.getByRole('link', { name: /PAY-13/ }).getAttribute('href')).toBe(
      'https://acme.atlassian.net/browse/PAY-13',
    );
    expect(screen.getByRole('link', { name: /PAY-14/ }).getAttribute('href')).toBe(
      'https://acme.atlassian.net/browse/PAY-14',
    );
  });

  it('danh sách rỗng → không render link nào', () => {
    render(<IssueKeyList issueKeys={[]} baseUrl="https://acme.atlassian.net" />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
