const STORAGE_KEY = 'entries';
const MAX_ENTRIES = 5000;
const cleanupsByElement = new WeakMap();

function makeDate(year, month, day) {
    return new Date(year, month, day, 12, 0, 0, 0);
}

function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = makeDate(year, month - 1, day);
    return dateKey(date) === value ? date : null;
}

function formatDay(value) {
    const date = parseDate(value);
    if (!date) return '';
    const weekday = '日一二三四五六'[date.getDay()];
    return `${date.getMonth() + 1}月${date.getDate()}日 · 周${weekday}`;
}

function isTime(value) {
    return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function sanitizeRecurrence(value, kind) {
    if (kind !== 'event' || !value || typeof value !== 'object') return null;
    if (value.type === 'weekly' && Array.isArray(value.days)) {
        const days = [...new Set(value.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
            .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
        return days.length ? { type: 'weekly', days } : null;
    }
    if (value.type === 'monthly' && Array.isArray(value.days)) {
        const days = [...new Set(value.days.filter((day) => Number.isInteger(day) && day >= 1 && day <= 31))]
            .sort((a, b) => a - b);
        return days.length ? { type: 'monthly', days } : null;
    }
    return null;
}

function sanitizeEntries(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_ENTRIES).flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const date = parseDate(entry.date);
        const kind = entry.kind === 'task' ? 'task' : entry.kind === 'event' ? 'event' : null;
        const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, 120) : '';
        if (!date || !kind || !title) return [];
        const completedDate = parseDate(entry.doneDate);
        return [{
            id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 100) : createId(),
            date: dateKey(date),
            kind,
            title,
            start: kind === 'event' && isTime(entry.start) ? entry.start : '',
            end: kind === 'event' && isTime(entry.end) ? entry.end : '',
            note: typeof entry.note === 'string' ? entry.note.slice(0, 500) : '',
            doneDate: completedDate ? dateKey(completedDate) : (kind === 'task' && entry.done === true ? dateKey(date) : ''),
            recurrence: sanitizeRecurrence(entry.recurrence, kind),
        }];
    });
}

function entryIsDoneOn(entry, value) {
    return entry?.doneDate === value;
}

function entryOccursOn(entry, value) {
    if (!entry.recurrence) return entry.date === value;
    if (value < entry.date) return false;
    const date = parseDate(value);
    if (!date) return false;
    if (entry.recurrence.type === 'weekly') return entry.recurrence.days.includes(date.getDay());
    if (entry.recurrence.type === 'monthly') return entry.recurrence.days.includes(date.getDate());
    return entry.date === value;
}

function recurrenceLabel(recurrence) {
    if (!recurrence) return '';
    if (recurrence.type === 'weekly') {
        const weekdays = '日一二三四五六';
        return `每周${recurrence.days.map((day) => `周${weekdays[day]}`).join('、')}`;
    }
    return `每月${recurrence.days.map((day) => `${day}日`).join('、')}`;
}

function createId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function node(doc, tag, className, text) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

export default {
    setup(el, ctx) {
        const doc = el.ownerDocument;
        const panel = el.querySelector('[data-schedule-panel]');
        const layout = el.querySelector('[data-schedule-layout]');
        const dayPane = el.querySelector('.schedule-day');
        const monthLabel = el.querySelector('[data-month-label]');
        const calendarGrid = el.querySelector('[data-calendar-grid]');
        const dayLabel = el.querySelector('[data-day-label]');
        const dayList = el.querySelector('[data-day-list]');
        const saveStatus = el.querySelector('[data-save-status]');
        const contextMenu = el.querySelector('[data-context-menu]');
        const contextAddButton = contextMenu?.querySelector('[data-context-add]');
        const contextEditButton = contextMenu?.querySelector('[data-context-edit]');
        const form = el.querySelector('[data-entry-form]');
        const formTitle = el.querySelector('[data-form-title]');
        const timeFields = el.querySelector('[data-time-fields]');
        const recurrenceSection = el.querySelector('[data-recurrence-section]');
        const repeatOptions = el.querySelector('[data-repeat-options]');
        const repeatCalendar = el.querySelector('[data-repeat-calendar]');
        const repeatCalendarLabel = el.querySelector('[data-repeat-calendar-label]');
        const repeatWeekdays = el.querySelector('[data-repeat-weekdays]');
        const repeatGrid = el.querySelector('[data-repeat-grid]');
        const repeatSummary = el.querySelector('[data-repeat-summary]');
        const formError = el.querySelector('[data-form-error]');
        const deleteButton = el.querySelector('[data-delete]');
        const titleInput = form.elements.namedItem('title');
        const kindInput = form.elements.namedItem('kind');
        const dateInput = form.elements.namedItem('date');
        const startInput = form.elements.namedItem('start');
        const endInput = form.elements.namedItem('end');
        const noteInput = form.elements.namedItem('note');

        let entries = [];
        let selectedDate = dateKey(new Date());
        let monthCursor = parseDate(selectedDate);
        let editingId = null;
        let contextEntryId = null;
        let repeatMode = 'once';
        let repeatFrequency = '';
        let repeatCalendarCursor = parseDate(selectedDate);
        let selectedWeekdays = new Set();
        let selectedMonthdays = new Set();
        let animateCompletionId = null;
        let disposed = false;
        let writeChain = Promise.resolve();

        const listeners = [];
        const listen = (targetOrTargets, type, handler) => {
            const targets = targetOrTargets?.addEventListener
                ? [targetOrTargets]
                : Array.from(targetOrTargets ?? []);
            for (const target of targets) target.addEventListener(type, handler);
            listeners.push(() => {
                for (const target of targets) target.removeEventListener(type, handler);
            });
        };

        function setStatus(message, state = '') {
            saveStatus.textContent = message;
            if (state) saveStatus.dataset.state = state;
            else delete saveStatus.dataset.state;
        }

        function save() {
            const snapshot = entries.map((entry) => ({
                ...entry,
                recurrence: entry.recurrence ? { type: entry.recurrence.type, days: [...entry.recurrence.days] } : null,
            }));
            writeChain = writeChain.catch(() => {}).then(() => ctx.settings.set(STORAGE_KEY, snapshot));
            writeChain.then(() => {
                if (!disposed) setStatus('已保存', 'saved');
            }).catch(() => {
                if (!disposed) setStatus('保存失败', 'error');
            });
        }

        function entriesForDate(value) {
            return entries.filter((entry) => entryOccursOn(entry, value)).sort((a, b) => {
                if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1;
                if (a.kind === 'event') return (a.start || '99:99').localeCompare(b.start || '99:99');
                return Number(entryIsDoneOn(a, value)) - Number(entryIsDoneOn(b, value)) || a.title.localeCompare(b.title, 'zh-CN');
            });
        }

        function dayMarkers(value) {
            const list = entriesForDate(value);
            return {
                events: list.filter((entry) => entry.kind === 'event').length,
                tasks: list.filter((entry) => entry.kind === 'task').length,
                total: list.length,
            };
        }

        function renderWeeklyRecurrenceCalendar() {
            const cursor = repeatCalendarCursor ?? parseDate(dateInput.value) ?? parseDate(selectedDate);
            const mondayOffset = (cursor.getDay() + 6) % 7;
            const monday = makeDate(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - mondayOffset);
            const sunday = makeDate(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
            const startLabel = `${monday.getMonth() + 1}月${monday.getDate()}日`;
            const endLabel = `${sunday.getMonth() + 1}月${sunday.getDate()}日`;
            repeatCalendarLabel.textContent = `${monday.getFullYear()}年 ${startLabel} — ${endLabel}`;
            repeatWeekdays.hidden = true;
            repeatGrid.replaceChildren();

            const weekdayNames = '日一二三四五六';
            for (let index = 0; index < 7; index += 1) {
                const date = makeDate(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
                const weekday = date.getDay();
                const button = node(doc, 'button', 'recurrence-day recurrence-week-day');
                button.type = 'button';
                button.dataset.repeatWeekday = String(weekday);
                button.setAttribute('aria-pressed', String(selectedWeekdays.has(weekday)));
                button.setAttribute('aria-label', `每周${weekdayNames[weekday]}，${date.getMonth() + 1}月${date.getDate()}日`);
                if (selectedWeekdays.has(weekday)) button.classList.add('is-selected');
                button.append(
                    node(doc, 'span', 'recurrence-day-name', `周${weekdayNames[weekday]}`),
                    node(doc, 'span', 'recurrence-day-number', String(date.getDate())),
                );
                repeatGrid.appendChild(button);
            }
        }

        function renderMonthlyRecurrenceCalendar() {
            const cursor = repeatCalendarCursor ?? parseDate(dateInput.value) ?? parseDate(selectedDate);
            const year = cursor.getFullYear();
            const month = cursor.getMonth();
            repeatCalendarLabel.textContent = `${year}年${month + 1}月`;
            repeatWeekdays.hidden = false;
            repeatGrid.replaceChildren();

            const first = makeDate(year, month, 1);
            const mondayOffset = (first.getDay() + 6) % 7;
            const start = makeDate(year, month, 1 - mondayOffset);
            for (let index = 0; index < 42; index += 1) {
                const date = makeDate(start.getFullYear(), start.getMonth(), start.getDate() + index);
                const button = node(doc, 'button', 'recurrence-day recurrence-month-day', String(date.getDate()));
                button.type = 'button';
                if (date.getMonth() !== month) {
                    button.classList.add('is-outside');
                    button.disabled = true;
                    button.setAttribute('aria-hidden', 'true');
                } else {
                    button.dataset.repeatMonthday = String(date.getDate());
                    button.setAttribute('aria-pressed', String(selectedMonthdays.has(date.getDate())));
                    button.setAttribute('aria-label', `每月${date.getDate()}日`);
                    if (selectedMonthdays.has(date.getDate())) button.classList.add('is-selected');
                }
                repeatGrid.appendChild(button);
            }
        }

        function renderRecurrence() {
            const isEvent = kindInput.value === 'event';
            const isRepeating = isEvent && repeatMode === 'repeat';
            const hasFrequency = repeatFrequency === 'weekly' || repeatFrequency === 'monthly';
            recurrenceSection.hidden = !isEvent;
            repeatOptions.hidden = !isRepeating;

            for (const button of el.querySelectorAll('[data-repeat-mode]')) {
                const active = button.dataset.repeatMode === repeatMode;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', String(active));
            }
            for (const button of el.querySelectorAll('[data-repeat-period]')) {
                const active = button.dataset.repeatPeriod === repeatFrequency;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', String(active));
            }

            repeatCalendar.hidden = !isRepeating || !hasFrequency;
            repeatGrid.setAttribute('aria-label', repeatFrequency === 'weekly' ? '选择每周重复的星期' : '选择每月重复的日期');
            if (!isRepeating || !hasFrequency) {
                repeatSummary.textContent = isRepeating ? '先选择按周或按月' : '';
                repeatSummary.classList.remove('has-selection');
                return;
            }

            if (repeatFrequency === 'weekly') renderWeeklyRecurrenceCalendar();
            else renderMonthlyRecurrenceCalendar();

            const recurrence = repeatFrequency === 'weekly'
                ? { type: 'weekly', days: [...selectedWeekdays] }
                : { type: 'monthly', days: [...selectedMonthdays] };
            const hasSelection = recurrence.days.length > 0;
            repeatSummary.textContent = hasSelection
                ? recurrenceLabel(recurrence)
                : repeatFrequency === 'weekly' ? '点选一周中的日期，可多选' : '点选每月重复的日期，可多选';
            repeatSummary.classList.toggle('has-selection', hasSelection);
        }

        function renderCalendar() {
            const year = monthCursor.getFullYear();
            const month = monthCursor.getMonth();
            monthLabel.textContent = `${year}年${month + 1}月`;
            calendarGrid.replaceChildren();

            const first = makeDate(year, month, 1);
            const mondayOffset = (first.getDay() + 6) % 7;
            const start = makeDate(year, month, 1 - mondayOffset);
            const today = dateKey(new Date());

            for (let index = 0; index < 42; index += 1) {
                const date = makeDate(start.getFullYear(), start.getMonth(), start.getDate() + index);
                const key = dateKey(date);
                const markers = dayMarkers(key);
                const button = node(doc, 'button', 'calendar-day');
                button.type = 'button';
                button.dataset.date = key;
                button.setAttribute('role', 'gridcell');
                button.setAttribute('aria-pressed', String(key === selectedDate));
                button.setAttribute('aria-label', `${key}${markers.total ? `，${markers.total}项安排` : ''}`);
                if (date.getMonth() !== month) button.classList.add('outside');
                if (key === today) button.classList.add('today');
                if (key === selectedDate) button.classList.add('selected');
                button.appendChild(node(doc, 'span', '', String(date.getDate())));

                const dots = node(doc, 'span', 'day-dots');
                dots.setAttribute('aria-hidden', 'true');
                for (let dot = 0; dot < Math.min(3, markers.events); dot += 1) {
                    dots.appendChild(node(doc, 'i'));
                }
                for (let dot = 0; dot < Math.min(3 - dots.childElementCount, markers.tasks); dot += 1) {
                    const taskDot = node(doc, 'i');
                    taskDot.dataset.kind = 'task';
                    dots.appendChild(taskDot);
                }
                button.appendChild(dots);
                calendarGrid.appendChild(button);
            }
        }

        function makeEntryCard(entry) {
            const isDone = entryIsDoneOn(entry, selectedDate);
            const article = node(doc, 'article', `entry-card${isDone ? ' is-done' : ''}`);
            article.dataset.kind = entry.kind;
            article.dataset.entryId = entry.id;
            if (entry.kind === 'event') {
                article.tabIndex = 0;
                article.dataset.toggleEvent = entry.id;
                article.setAttribute('role', 'button');
                article.setAttribute('aria-pressed', String(isDone));
                article.setAttribute('aria-label', `${entry.title}，${isDone ? '已完成' : '未完成'}`);
                if (isDone && animateCompletionId === entry.id) article.classList.add('is-completion-animating');
                const time = node(doc, 'div', 'entry-time');
                if (entry.start) {
                    time.appendChild(node(doc, 'span', '', entry.end ? `${entry.start}–` : entry.start));
                    if (entry.end) time.appendChild(node(doc, 'span', '', entry.end));
                } else {
                    time.textContent = '全天';
                }
                article.appendChild(time);
                const doneMark = node(doc, 'span', 'entry-done-mark');
                doneMark.setAttribute('aria-hidden', 'true');
                doneMark.innerHTML = '<svg viewBox="0 0 16 16"><path d="m3 8 3.1 3.2L13 4.5"></path></svg>';
                article.appendChild(doneMark);
            } else {
                const check = node(doc, 'input', 'task-check');
                check.type = 'checkbox';
                check.checked = isDone;
                check.dataset.toggleTask = entry.id;
                check.setAttribute('aria-label', `${isDone ? '取消完成' : '完成'}：${entry.title}`);
                article.appendChild(check);
            }

            const main = node(doc, 'div', 'entry-main');
            main.appendChild(node(doc, 'div', 'entry-title', entry.title));
            if (entry.note) main.appendChild(node(doc, 'div', 'entry-note', entry.note));
            article.appendChild(main);
            return article;
        }

        function renderDay() {
            dayLabel.textContent = formatDay(selectedDate);
            const list = entriesForDate(selectedDate);
            dayList.replaceChildren();

            if (list.length === 0) {
                dayList.appendChild(node(doc, 'div', 'empty-day', '这一天还没有安排'));
                return;
            }

            const events = list.filter((entry) => entry.kind === 'event');
            const tasks = list.filter((entry) => entry.kind === 'task');
            if (events.length) {
                if (tasks.length) dayList.appendChild(node(doc, 'div', 'list-section-label', '日程'));
                for (const entry of events) dayList.appendChild(makeEntryCard(entry));
            }
            if (tasks.length) {
                dayList.appendChild(node(doc, 'div', 'list-section-label', '待办'));
                for (const entry of tasks) dayList.appendChild(makeEntryCard(entry));
            }
        }

        function render() {
            renderCalendar();
            renderDay();
            animateCompletionId = null;
        }

        function toggleEventCompletion(entry) {
            const willComplete = !entryIsDoneOn(entry, selectedDate);
            entry.doneDate = willComplete ? selectedDate : '';
            animateCompletionId = willComplete ? entry.id : null;
            render();
            save();
        }

        function hideForm() {
            contextMenu.hidden = true;
            form.hidden = true;
            form.reset();
            editingId = null;
            repeatMode = 'once';
            repeatFrequency = '';
            selectedWeekdays = new Set();
            selectedMonthdays = new Set();
            deleteButton.hidden = true;
            formError.hidden = true;
            formError.textContent = '';
        }

        function showForm(entry = null) {
            editingId = entry?.id ?? null;
            formTitle.textContent = entry ? '编辑事项' : '新建事项';
            titleInput.value = entry?.title ?? '';
            kindInput.value = entry?.kind ?? 'event';
            dateInput.value = entry?.date ?? selectedDate;
            startInput.value = entry?.start || '09:00';
            endInput.value = entry?.end || '09:30';
            noteInput.value = entry?.note ?? '';
            repeatMode = entry?.recurrence ? 'repeat' : 'once';
            repeatFrequency = entry?.recurrence?.type ?? '';
            selectedWeekdays = new Set(entry?.recurrence?.type === 'weekly' ? entry.recurrence.days : []);
            selectedMonthdays = new Set(entry?.recurrence?.type === 'monthly' ? entry.recurrence.days : []);
            repeatCalendarCursor = parseDate(dateInput.value) ?? parseDate(selectedDate);
            deleteButton.hidden = !entry;
            formError.hidden = true;
            formError.textContent = '';
            updateTimeFields();
            form.hidden = false;
            titleInput.focus();
        }

        function updateTimeFields() {
            const isEvent = kindInput.value === 'event';
            timeFields.hidden = !isEvent;
            startInput.required = isEvent;
            endInput.required = isEvent;
            if (!isEvent) {
                repeatMode = 'once';
                repeatFrequency = '';
                selectedWeekdays.clear();
                selectedMonthdays.clear();
            }
            renderRecurrence();
        }

        function shiftMonth(delta) {
            const selected = parseDate(selectedDate);
            const targetMonth = makeDate(selected.getFullYear(), selected.getMonth() + delta, 1);
            const maxDay = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate();
            selectedDate = dateKey(makeDate(targetMonth.getFullYear(), targetMonth.getMonth(), Math.min(selected.getDate(), maxDay)));
            monthCursor = makeDate(targetMonth.getFullYear(), targetMonth.getMonth(), 1);
            hideForm();
            render();
        }

        function onSubmit(event) {
            event.preventDefault();
            formError.hidden = true;
            if (!form.reportValidity()) return;

            const kind = kindInput.value;
            const date = parseDate(dateInput.value);
            const title = titleInput.value.trim();
            if (!date) return;
            if (!title) {
                formError.textContent = '请输入事项名称';
                formError.hidden = false;
                titleInput.focus();
                return;
            }
            if (kind === 'event' && endInput.value <= startInput.value) {
                formError.textContent = '结束时间要晚于开始时间';
                formError.hidden = false;
                endInput.focus();
                return;
            }

            let recurrence = null;
            if (kind === 'event' && repeatMode === 'repeat') {
                if (!repeatFrequency) {
                    formError.textContent = '请选择按周或按月';
                    formError.hidden = false;
                    repeatOptions.querySelector('[data-repeat-period]')?.focus();
                    return;
                }
                const days = repeatFrequency === 'weekly'
                    ? [...selectedWeekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
                    : [...selectedMonthdays].sort((a, b) => a - b);
                if (!days.length) {
                    formError.textContent = '请在日历中至少选择一个循环日期';
                    formError.hidden = false;
                    repeatGrid.querySelector('button:not(:disabled)')?.focus();
                    return;
                }
                recurrence = { type: repeatFrequency, days };
            }

            const entry = {
                id: editingId ?? createId(),
                date: dateKey(date),
                kind,
                title,
                start: kind === 'event' ? startInput.value : '',
                end: kind === 'event' ? endInput.value : '',
                note: noteInput.value.trim(),
                doneDate: entries.find((item) => item.id === editingId)?.doneDate === dateKey(date)
                    ? dateKey(date)
                    : '',
                recurrence,
            };
            const existingIndex = entries.findIndex((item) => item.id === editingId);
            if (existingIndex >= 0) entries.splice(existingIndex, 1, entry);
            else entries.push(entry);

            selectedDate = entry.date;
            monthCursor = makeDate(date.getFullYear(), date.getMonth(), 1);
            hideForm();
            render();
            save();
        }

        function removeEntry() {
            if (!editingId) return;
            const entry = entries.find((item) => item.id === editingId);
            if (!entry || !doc.defaultView.confirm(`删除“${entry.title}”？`)) return;
            entries = entries.filter((item) => item.id !== editingId);
            hideForm();
            render();
            save();
        }

        const view = doc.defaultView;
        let todayDate = selectedDate;
        const dayRolloverTimer = view.setInterval(() => {
            const today = dateKey(new Date());
            if (today === todayDate) return;
            const wasFollowingToday = selectedDate === todayDate;
            todayDate = today;
            if (!wasFollowingToday) return;
            selectedDate = today;
            monthCursor = parseDate(today);
            render();
        }, 60_000);
        listen(dayPane, 'contextmenu', (event) => {
            event.preventDefault();
            const entryCard = event.target.closest('.entry-card');
            contextEntryId = entryCard?.dataset.entryId || null;
            contextAddButton.hidden = Boolean(contextEntryId);
            contextEditButton.hidden = !contextEntryId;
            contextMenu.hidden = false;
            const bounds = contextMenu.getBoundingClientRect();
            const panelBounds = panel.getBoundingClientRect();
            const maxLeft = Math.max(8, panel.clientWidth - bounds.width - 8);
            const maxTop = Math.max(8, panel.clientHeight - bounds.height - 8);
            contextMenu.style.left = `${Math.min(Math.max(8, event.clientX - panelBounds.left), maxLeft)}px`;
            contextMenu.style.top = `${Math.min(Math.max(8, event.clientY - panelBounds.top), maxTop)}px`;
            (contextEntryId ? contextEditButton : contextAddButton).focus();
        });
        listen(contextAddButton, 'click', () => {
            contextMenu.hidden = true;
            contextEntryId = null;
            kindInput.value = 'event';
            showForm();
        });
        listen(contextEditButton, 'click', () => {
            contextMenu.hidden = true;
            const entry = entries.find((item) => item.id === contextEntryId);
            contextEntryId = null;
            if (entry) showForm(entry);
        });
        listen(doc, 'pointerdown', (event) => {
            if (!contextMenu.hidden && !contextMenu.contains(event.target)) contextMenu.hidden = true;
        });
        listen(doc, 'keydown', (event) => {
            if (event.key !== 'Escape' || contextMenu.hidden) return;
            contextMenu.hidden = true;
            layout.focus();
        });
        listen(view, 'blur', () => { contextMenu.hidden = true; });
        const dragScroll = { pointerId: null, startY: 0, startScrollTop: 0, moved: false };
        listen(layout, 'pointerdown', (event) => {
            if (event.pointerType !== 'mouse' || event.button !== 0) return;
            if (event.target === layout && event.offsetX >= layout.clientWidth) return;
            if (event.target.closest('button,input,select,textarea,a,[contenteditable="true"],.entry-card')) return;
            dragScroll.pointerId = event.pointerId;
            dragScroll.startY = event.clientY;
            dragScroll.startScrollTop = layout.scrollTop;
            dragScroll.moved = false;
            layout.setPointerCapture?.(event.pointerId);
        });
        listen(layout, 'pointermove', (event) => {
            if (dragScroll.pointerId !== event.pointerId) return;
            const deltaY = event.clientY - dragScroll.startY;
            if (!dragScroll.moved && Math.abs(deltaY) < 4) return;
            dragScroll.moved = true;
            layout.classList.add('is-dragging');
            event.preventDefault();
            layout.scrollTop = dragScroll.startScrollTop - deltaY;
        });
        const finishDragScroll = (event) => {
            if (dragScroll.pointerId !== event.pointerId) return;
            dragScroll.pointerId = null;
            layout.classList.remove('is-dragging');
            if (layout.hasPointerCapture?.(event.pointerId)) layout.releasePointerCapture(event.pointerId);
        };
        listen(layout, 'pointerup', finishDragScroll);
        listen(layout, 'pointercancel', finishDragScroll);
        listen(el.querySelectorAll('[data-cancel]'), 'click', (event) => {
            event.preventDefault();
            hideForm();
        });
        listen(form, 'submit', onSubmit);
        listen(kindInput, 'change', updateTimeFields);
        listen(dateInput, 'change', () => {
            const date = parseDate(dateInput.value);
            if (!date) return;
            repeatCalendarCursor = date;
            renderRecurrence();
        });
        listen(form, 'click', (event) => {
            const modeButton = event.target.closest('[data-repeat-mode]');
            if (modeButton) {
                repeatMode = modeButton.dataset.repeatMode;
                formError.hidden = true;
                formError.textContent = '';
                renderRecurrence();
                return;
            }

            const periodButton = event.target.closest('[data-repeat-period]');
            if (periodButton) {
                repeatFrequency = periodButton.dataset.repeatPeriod;
                repeatCalendarCursor = parseDate(dateInput.value) ?? parseDate(selectedDate);
                formError.hidden = true;
                formError.textContent = '';
                renderRecurrence();
                return;
            }

            const calendarStep = event.target.closest('[data-repeat-calendar-step]');
            if (calendarStep) {
                const delta = Number(calendarStep.dataset.repeatCalendarStep);
                const cursor = repeatCalendarCursor ?? parseDate(dateInput.value) ?? parseDate(selectedDate);
                repeatCalendarCursor = repeatFrequency === 'weekly'
                    ? makeDate(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + delta * 7)
                    : makeDate(cursor.getFullYear(), cursor.getMonth() + delta, 1);
                renderRecurrence();
                return;
            }

            const weekdayButton = event.target.closest('[data-repeat-weekday]');
            if (weekdayButton) {
                const day = Number(weekdayButton.dataset.repeatWeekday);
                if (selectedWeekdays.has(day)) selectedWeekdays.delete(day);
                else selectedWeekdays.add(day);
                formError.hidden = true;
                formError.textContent = '';
                renderRecurrence();
                return;
            }

            const monthdayButton = event.target.closest('[data-repeat-monthday]');
            if (monthdayButton) {
                const day = Number(monthdayButton.dataset.repeatMonthday);
                if (selectedMonthdays.has(day)) selectedMonthdays.delete(day);
                else selectedMonthdays.add(day);
                formError.hidden = true;
                formError.textContent = '';
                renderRecurrence();
            }
        });
        listen(deleteButton, 'click', removeEntry);
        listen(calendarGrid, 'click', (event) => {
            const button = event.target.closest('[data-date]');
            if (!button || !calendarGrid.contains(button)) return;
            selectedDate = button.dataset.date;
            const selected = parseDate(selectedDate);
            monthCursor = makeDate(selected.getFullYear(), selected.getMonth(), 1);
            hideForm();
            render();
        });
        listen(el, 'click', (event) => {
            const monthButton = event.target.closest('[data-month-step]');
            if (monthButton) {
                shiftMonth(Number(monthButton.dataset.monthStep));
                return;
            }
            const eventCard = event.target.closest('[data-toggle-event]');
            if (eventCard) {
                const entry = entries.find((item) => item.id === eventCard.dataset.toggleEvent);
                if (!entry) return;
                toggleEventCompletion(entry);
                return;
            }
            const checkbox = event.target.closest('[data-toggle-task]');
            if (checkbox) {
                const entry = entries.find((item) => item.id === checkbox.dataset.toggleTask);
                if (!entry) return;
                entry.doneDate = checkbox.checked ? selectedDate : '';
                render();
                save();
            }
        });
        listen(dayList, 'keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const eventCard = event.target.closest('[data-toggle-event]');
            if (!eventCard) return;
            event.preventDefault();
            const entry = entries.find((item) => item.id === eventCard.dataset.toggleEvent);
            if (!entry) return;
            toggleEventCompletion(entry);
        });

        cleanupsByElement.set(el, () => {
            disposed = true;
            view.clearInterval(dayRolloverTimer);
            listeners.splice(0).forEach((off) => off());
            contextMenu.hidden = true;
        });

        void (async () => {
            try {
                const storedEntries = await ctx.settings.get(STORAGE_KEY, []);
                entries = sanitizeEntries(storedEntries);
                if (disposed) return;
                panel.setAttribute('aria-busy', 'false');
                setStatus('已保存', 'saved');
                render();
            } catch {
                if (disposed) return;
                panel.setAttribute('aria-busy', 'false');
                setStatus('读取失败，暂不可编辑', 'error');
                render();
            }
        })();

    },

    teardown(el) {
        cleanupsByElement.get(el)?.();
        cleanupsByElement.delete(el);
    },
};
