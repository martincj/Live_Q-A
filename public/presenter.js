const socket = io();

const liveQuestionContent = document.getElementById('live-question-content');
const nextUpQuestionContent = document.getElementById('next-up-question-content');
const approvedQuestionsContent = document.getElementById('approved-questions-content');
const timerContent = document.getElementById('timer-content');

let timerInterval;
let timerSeconds = 0;

socket.on('live_question', (question) => {
    if (question) {
        liveQuestionContent.innerHTML = `
            <div>${question.text}</div>
            <div>- ${question.username}</div>
        `;
        startTimer();
    } else {
        liveQuestionContent.innerHTML = '';
        stopTimer();
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

function startTimer() {
    stopTimer();
    timerSeconds = 0;
    timerInterval = setInterval(() => {
        timerSeconds++;
        updateTimerDisplay();
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
}

function updateTimerDisplay() {
    const minutes = Math.floor(timerSeconds / 60);
    const seconds = timerSeconds % 60;
    timerContent.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    if (timerSeconds < 120) {
        timerContent.style.color = 'lightgreen';
    } else if (timerSeconds < 300) {
        timerContent.style.color = 'yellow';
    } else {
        timerContent.style.color = 'red';
    }
}
