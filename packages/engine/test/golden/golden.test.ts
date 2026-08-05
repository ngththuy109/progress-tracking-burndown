import { describe, expect, it } from 'vitest';
import {
  goldenIds,
  hasReadme,
  loadExpected,
  loadInput,
  runFixture,
  stripDocs,
  toPlainJson,
} from '../helpers/load-fixture.js';

/**
 * Bộ chạy 20 golden dataset — PRD §8.2 gọi đây là "trái tim của việc kiểm thử".
 *
 * NGUYÊN TẮC SỐNG CÒN: mọi con số trong `expected.json` đều được **tính tay** và
 * ghi cách tính vào trường `_how`. Sinh `expected.json` bằng cách chạy code hiện
 * tại rồi chép đầu ra là cách nhanh nhất để có một bộ test **vô dụng**: nó đóng
 * băng đúng những bug đang có và xanh mãi mãi.
 *
 * Meta-test bên dưới canh chính điều đó.
 */

const IDS = goldenIds();

describe('20 golden dataset', () => {
  it('có đủ 20 bộ, đánh số liên tục GD-01 → GD-20', () => {
    // Đếm ở đây chứ không tin vào việc "chắc là đủ": thiếu một bộ thì bộ test
    // vẫn xanh và không ai biết kịch bản nào chưa được phủ.
    const expectedIds = Array.from({ length: 20 }, (_, i) => `GD-${String(i + 1).padStart(2, '0')}`);
    expect(IDS).toEqual(expectedIds);
  });

  describe.each(IDS)('%s', (id) => {
    it('cho ra đúng kết quả đã tính tay', () => {
      const input = loadInput(id);
      const expected = loadExpected(id);
      expect(toPlainJson(runFixture(input))).toEqual(stripDocs(expected));
    });

    it('chạy hai lần cho kết quả giống hệt nhau', () => {
      // Engine phải thuần: cùng đầu vào, cùng đầu ra. Lẫn `Date.now()` hay thứ
      // tự duyệt `Map` không ổn định vào là test này đỏ.
      const input = loadInput(id);
      expect(toPlainJson(runFixture(input))).toEqual(toPlainJson(runFixture(loadInput(id))));
    });
  });
});

describe('meta-test — canh chất lượng của chính bộ fixture', () => {
  it('mọi fixture đều khai asOfDate tường minh', () => {
    // Engine không được đọc đồng hồ. Fixture quên khai "hôm nay" sẽ tạo test
    // xanh hôm nay và đỏ tuần sau.
    for (const id of IDS) {
      const input = loadInput(id) as { asOfDate?: unknown };
      expect(typeof input.asOfDate, id).toBe('string');
      expect(String(input.asOfDate), id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('mọi expected.json đều ghi cách tính tay ở trường _how', () => {
    // Đây là hàng rào chống "chạy code rồi chép đầu ra". Không chống được tuyệt
    // đối, nhưng buộc người viết phải nói ra mình đã tính thế nào.
    for (const id of IDS) {
      const expected = loadExpected(id) as { _how?: unknown };
      expect(typeof expected._how, `${id} thiếu trường _how`).toBe('string');
      expect(String(expected._how).length, `${id} có _how quá sơ sài`).toBeGreaterThan(60);
    }
  });

  it('mọi fixture đều có README giải thích kịch bản', () => {
    for (const id of IDS) {
      expect(hasReadme(id), `${id} thiếu README.md`).toBe(true);
    }
  });

  it('mọi fixture đều khai id trùng với tên thư mục', () => {
    for (const id of IDS) {
      expect((loadInput(id) as { id?: unknown }).id, id).toBe(id);
    }
  });

  it('mọi fixture đều có tiêu đề tiếng Việt mô tả kịch bản', () => {
    for (const id of IDS) {
      const title = (loadInput(id) as { title?: unknown }).title;
      expect(typeof title, id).toBe('string');
      expect(String(title).length, id).toBeGreaterThan(10);
    }
  });
});
