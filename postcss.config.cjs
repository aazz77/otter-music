/**
 * 把 CSS 里的 @layer 块拍平为顶层规则。
 *
 * 背景：Tailwind v4 的产物全部包在 @layer theme/base/components/utilities 里，
 * Chrome 99+ 才支持 @layer；Android TV 老系统 WebView（如 Chromium 66）遇到
 * 不认识的 at-rule 会整块丢弃，导致页面完全无样式。
 *
 * 拍平后按文档顺序拼接（properties → theme → base → components → utilities），
 * 后面的 utilities 在同特异性冲突时胜出，与 layer 优先级语义一致。
 * 空的 `@layer a, b;` 声明语句直接移除。
 */
function flattenCssLayers() {
  return {
    postcssPlugin: "flatten-css-layers",
    Once(root) {
      // replaceWith 插入的子节点不会被本次 walk 继续访问，
      // 循环直到没有 @layer 为止，处理（可能存在的）嵌套 layer
      let found = true;
      let guard = 0;
      while (found && guard < 10) {
        found = false;
        guard++;
        root.walkAtRules("layer", (atRule) => {
          found = true;
          if (atRule.nodes && atRule.nodes.length > 0) {
            atRule.replaceWith(atRule.nodes);
          } else {
            atRule.remove();
          }
        });
      }
    },
  };
}

flattenCssLayers.postcss = true;

module.exports = {
  plugins: [require("@tailwindcss/postcss")(), flattenCssLayers],
};
