const socket = io();

const liveQuestionContent = document.getElementById('live-question-content');
const nextUpQuestionContent = document.getElementById('next-up-question-content');
const approvedQuestionsContent = document.getElementById('approved-questions-content');
const timerContent = document.getElementById('timer-content');

let timerSeconds = 0;

socket.on('live_question', (question) => {
    if (question) {
        liveQuestionContent.innerHTML = `
            <div>${question.text}</div>
            <div>- ${question.username}</div>
        `;
    } else {
        liveQuestionContent.innerHTML = '';
    }
});

socket.on('next_up_question', (question) => {
    if (question) {
        nextUpQuestionContent.innerHTML = `
            <div>${question.text}</div>
            <div>- ${question.username}</div>
        `;
    } else {
        nextUpQuestionContent.innerHTML = '';
    }
});

socket.on('approved_questions', (questions) => {
    approvedQuestionsContent.innerHTML = '';
    questions.forEach(q => {
        const div = document.createElement('div');
        div.innerHTML = `<div>${q.text}</div><div>- ${q.username}</div><hr>`;
        approvedQuestionsContent.appendChild(div);
    });
});

function fetchApprovedQuestions() {
    socket.emit('get_approved_questions');
}

// Fetch approved questions every 5 seconds
setInterval(fetchApprovedQuestions, 5000);

// Initial fetch
fetchApprovedQuestions();

const timer03 = document.getElementById('timer-0-3');
const timer35 = document.getElementById('timer-3-5');
const timer5plus = document.getElementById('timer-5-plus');
const timer10plus = document.getElementById('timer-10-plus');

socket.on('timer_state', (state) => {
  timerSeconds = state.seconds;
  updateTimerDisplay(state.running);
});

function updateTimerDisplay(running) {
    const minutes = Math.floor(timerSeconds / 60);

    // Reset all to grey
    timer03.className = 'timer-range grey';
    timer35.className = 'timer-range grey';
    timer5plus.className = 'timer-range grey';

    timer10plus.style.display = 'none';
    timer03.style.display = 'block';
    timer35.style.display = 'block';
    timer5plus.style.display = 'block';

    if (running) {
        if (minutes < 3) {
            timer03.className = 'timer-range green';
        } else if (minutes < 5) {
            timer35.className = 'timer-range yellow';
        } else if (minutes < 10) {
            timer5plus.className = 'timer-range red';
        } else {
            timer03.style.display = 'none';
            timer35.style.display = 'none';
            timer5plus.style.display = 'none';
            timer10plus.style.display = 'block';
            timer10plus.className = 'timer-range-large red flashing';
        }
    }
}
