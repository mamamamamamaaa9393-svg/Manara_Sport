## الهدف

كتابة وتحسين CSS احترافي، Responsive، قابل للصيانة، ومتناسق بين جميع صفحات Manara بدون كسر التصميم الحالي.

## القواعد الأساسية

قبل تعديل CSS:

1. افحص HTML/JS المرتبط بالعنصر.
2. افحص CSS الحالي.
3. ابحث عن selectors متكررة أو متعارضة.
4. افهم نظام الألوان والمتغيرات الموجودة.
5. افحص التصميم على أحجام شاشات مختلفة.
6. لا تغير التصميم بالكامل إذا كان المطلوب إصلاحًا بسيطًا.

## Responsive Design

استخدم تصميمًا مرنًا.

يفضل استخدام:

* CSS Grid
* Flexbox
* `minmax()`
* `auto-fit`
* `auto-fill`
* `clamp()`
* relative units

تجنب:

* fixed widths غير الضرورية
* fixed heights التي تسبب overflow
* layouts تعتمد على شاشة واحدة
* تكرار Media Queries بدون حاجة

يجب أن يعمل التصميم على:

* Mobile
* Tablet
* Laptop
* Desktop
* Large screens

## Layout

استخدم:

```css
grid-template-columns: repeat(auto-fit, minmax(...));
```

أو:

```css
grid-template-columns: repeat(auto-fill, minmax(...));
```

عندما يكون المحتوى مناسبًا لذلك.

لا تستخدم عدد أعمدة ثابتًا إذا كان المحتوى يمكن أن يعيد التدفق تلقائيًا.

## CSS Variables

استعمل المتغيرات الموجودة مثل:

```css
var(--primary)
var(--bg-soft)
var(--line)
var(--ink)
var(--ink-2)
```

ولا تنشئ ألوانًا جديدة بدون حاجة.

إذا كان هناك Design System موجود، حافظ عليه.

## Typography

حافظ على:

* hierarchy واضح
* line-height مناسب
* readable font sizes
* text wrapping الصحيح
* RTL compatibility

لا تجعل النص يخرج خارج الحاويات.

## RTL

Manara يدعم اللغة العربية.

يجب مراعاة:

* `direction: rtl`
* logical properties مثل:
  `margin-inline`
  `padding-inline`
  `inset-inline`
  `border-inline`

تجنب الاعتماد غير الضروري على:

```css
margin-left
margin-right
left
right
```

خصوصًا في المكونات التي يجب أن تعمل مع RTL/LTR.

## Accessibility

حافظ على:

* contrast مناسب
* focus states
* keyboard accessibility
* touch target مناسب
* عدم الاعتماد على اللون وحده
* عدم إخفاء المحتوى المهم

لا تستخدم:

```css
outline: none;
```

بدون توفير focus style بديل.

## Components

حافظ على اتساق:

* buttons
* cards
* forms
* inputs
* navbar
* sidebar
* modals
* alerts
* tables
* social links
* profile components

لا تنشئ نفس التصميم بأسماء Classes مختلفة بدون سبب.

## Hover / Interaction

استخدم transitions خفيفة:

```css
transition: ...
```

ولا تستخدم animations مبالغًا فيها.

يجب مراعاة:

```css
@media (prefers-reduced-motion: reduce)
```

للحركات المهمة.

## Overflow

تحقق دائمًا من:

* horizontal scrolling
* overflowing text
* long URLs
* large images
* tables
* buttons
* cards

لا تستخدم:

```css
overflow: hidden;
```

فقط لإخفاء مشكلة layout.

حدد السبب الحقيقي للـ overflow.

## Z-index

لا تضف `z-index` عشوائيًا.

إذا كان هناك عنصر لا يمكن الضغط عليه:

تحقق من:

* `position`
* `z-index`
* `pointer-events`
* overlays
* pseudo-elements

قبل تغيير أي شيء.

## Mobile

لا تعتمد على:

```css
width: 100vw;
```

عندما قد تسبب horizontal overflow.

استخدم:

```css
width: 100%;
max-width: ...;
```

حيث يكون مناسبًا.

اختبر:

* 320px
* 375px
* 768px
* 1024px
* 1440px

## Performance

تجنب:

* selectors شديدة التعقيد
* CSS duplication
* unnecessary animations
* excessive box-shadows
* repeated overrides

لا تضف framework جديدًا فقط لحل مشكلة CSS بسيطة.

## قبل التعديل

حدد:

PROBLEM:
...

ROOT CAUSE:
...

AFFECTED FILES:
...

PLAN:
...

ولا تعدل ملفات غير مرتبطة بالمشكلة.

## بعد التعديل

تحقق من:

* Desktop
* Tablet
* Mobile
* RTL
* hover
* focus
* overflow
* broken layout
* existing components

إذا كانت أدوات الاختبار أو Browser automation متاحة، استخدمها.

## قاعدة مهمة

لا تصلح مشكلة CSS بطريقة تكسر صفحة أخرى.

ابحث عن تأثير الـ selector على المشروع كاملًا قبل تغييره.

## Final report

اذكر:

CHANGED:

* الملفات التي تغيرت

FIX:

* المشكلة التي تم حلها

RESPONSIVE:

* الأحجام التي تم التحقق منها

REGRESSION:

* هل تم فحص الصفحات المتأثرة؟

REMAINING:

* أي مشاكل لم يتم التحقق منها

لا تدّعي أن التصميم تم اختباره بصريًا إذا لم يتم تشغيل Browser أو Screenshot فعليًا.
