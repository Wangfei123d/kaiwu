// 粒子星空背景。从旧站 tools-core.js 第 108–208 行(第 3 节)整体迁移。
// 三处改动:① 包成 startStarfield(canvas);② 内部变量收进函数作用域;
// ③ 返回一个停止函数,方便卸载。
// 其余逻辑原样保留:双层发光圆、120px 连线、prefers-reduced-motion、
// visibilitychange 暂停、resize 重撒点。
export function startStarfield(canvas) {
    if (!canvas) return () => {};

    const ctx = canvas.getContext('2d');
    // 系统如果开了"减少动态效果"(无障碍设置),就只画一帧静态的
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    let particles = [];
    let rafId = null;                   // 动画帧句柄,用来暂停/恢复

    /**
     * 现在该不该动。
     *
     * 两个来源,任一命中就停:
     *   · 系统的 prefers-reduced-motion(启动时读一次,和从前一样);
     *   · 设置页那个「减少动态效果(强制关)」—— 它落在 `html[data-motion="off"]` 上,
     *     而 CSS 那条全局规则只能关掉 **CSS** 动画:星空是 canvas + requestAnimationFrame,
     *     不吃 CSS。所以这里必须自己看一眼(父任务的硬要求:星空也得真的停下来)。
     */
    function motionOff() {
        return reduceMotion === true
            || document.documentElement.getAttribute('data-motion') === 'off';
    }

    function initParticles() {
        canvas.width = innerWidth;
        canvas.height = innerHeight;
        // 小屏少撒点,省电
        const count = innerWidth <= 768 ? 40 : 70;
        particles = Array.from({ length: count }, () => ({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            vx: (Math.random() - .5) * .4,      // 微小随机速度,缓慢漂浮
            vy: (Math.random() - .5) * .4,
            r: 1 + Math.random() * 1.5,         // 半径 1~2.5px
        }));
    }

    // 每个粒子移动一小步,碰到边缘反弹
    function stepParticles() {
        for (const p of particles) {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
            if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        }
    }

    // 渲染一帧:双层圆模拟发光(外圈大而淡,内核小而亮)+ 近距粒子连线
    function renderScene() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        for (const p of particles) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(126, 200, 255, .08)';
            ctx.fill();

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(126, 200, 255, .55)';
            ctx.fill();
        }

        // 两两比较:距离小于 120px 画连线,越近越亮
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dist = Math.hypot(particles[i].x - particles[j].x,
                    particles[i].y - particles[j].y);
                if (dist < 120) {
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `rgba(126, 200, 255, ${.15 * (1 - dist / 120)})`;
                    ctx.stroke();
                }
            }
        }
    }

    function startLoop() {
        if (rafId !== null) return;         // 已经在跑就不重复启动
        const loop = () => {
            stepParticles();
            renderScene();
            rafId = requestAnimationFrame(loop);
        };
        loop();
    }

    function stopLoop() {
        cancelAnimationFrame(rafId);
        rafId = null;
    }

    function onVisibilityChange() {
        // 藏起来时一律停;回来时只有"不该停"才恢复
        if (document.hidden === true || motionOff() === true) stopLoop();
        else startLoop();
    }

    function onResize() {
        initParticles();
        if (motionOff() === true) renderScene();
    }

    /** 设置页那个开关翻转:立刻停/立刻恢复(不重载页面)。 */
    function onMotionChange() {
        if (motionOff() === true) {
            stopLoop();
            renderScene();                  // 留一帧静态的,画面不空
        } else if (document.hidden !== true) {
            startLoop();
        }
    }

    initParticles();

    if (motionOff() === true) {
        renderScene();                      // 只画一帧静态粒子
    } else {
        startLoop();
        // 切到别的标签页时暂停动画,切回来恢复,不白烧 CPU
        document.addEventListener('visibilitychange', onVisibilityChange);
    }

    // 窗口尺寸变化:重设画布、重新撒点
    addEventListener('resize', onResize);
    // 设置页的「减少动态效果(强制关)」(外壳在根属性变化时派发这个事件)
    document.addEventListener('kaiwu:motion', onMotionChange);

    return function stopStarfield() {
        stopLoop();
        removeEventListener('resize', onResize);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        document.removeEventListener('kaiwu:motion', onMotionChange);
    };
}
