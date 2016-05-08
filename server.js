var express = require('express');
var app = express();
var pg = require('pg');
var pgp = require('pg-promise')();
var expressSession = require('express-session');
var passport = require('passport');
var LocalStrategy = require('passport-local').Strategy;
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var socket = require('socket.io');
var fs = require('fs');
var handlebars = require('handlebars');
var dateFormat = require('dateformat');

/*   NOTE:
 *   get a GET parameter
 *     req.params.param
 *   get a POST parameter
 *     req.body.param
 */

handlebars.registerHelper("formatDate", function(datetime, format) {
	var date = new Date(Date.parse(datetime));
	if (format == "long") {
		var str = dateFormat(date, "mmmm dS, yyyy, h:MM:ss TT");
	} else {
		var str = date.toString();
	}
	return new handlebars.SafeString(str);
});
handlebars.registerHelper('gte', function(v1, v2, options) {
	if(parseInt(v1, 10) >= parseInt(v2, 10)) {
		return options.fn(this);
	}
	return options.inverse(this);
});
handlebars.registerHelper('empty', function(v1, options) {
	if(v1.length == 0) {
		return options.fn(this);
	}
	return options.inverse(this);
});

var NOT_AUTHENTICATED_MESSAGE = 'Access denied, please log in';
var PERMISSION_DENIED_MESSAGE = 'You do not have permission';
var NO_USER_FOUND_MESSAGE = 'no user found';
var USER_AUTHENTICATED = 'ok';

var connectionString = process.env.DATABASE_URL || 'postgres://postgres:root@localhost:5432/piq';
var db = pgp(connectionString);
var qrm = pgp.queryResult;
var page_size = 20;


app.use(express.static(__dirname + '/public'));
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(expressSession({ secret: 'keyboard cat', cookie: { maxAge: 1000 * 60 * 14 }, resave: true, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());



passport.serializeUser(function(user, done) {
    done(null, user.id);
});

passport.deserializeUser(function(id, done) {    
    db.query('SELECT * FROM "user" where id=$1', id, qrm.one).then(function (data) {
        if (data) {
            return done(null, data);
        }
        return done(null, false);
    }).catch(function (error) {
        console.log(error);
        return done(null, false);
    });
});

passport.use(new LocalStrategy({
    usernameField: 'email',
    passwordField: 'password',
    session: true
}, function(email, password, done) {    
    db.query('SELECT * FROM "user" where email=$1 and password=$2', [email, password], qrm.one).then(function (data) {
        if (data) {
            return done(null, data);
        }
        return done(null, false);
    }).catch(function (error) {
        console.log(error);
        return done(null, false);
    });
}));


function checkPermission(req, res, userID, moduleID, callback, failedCallback) {
    db.query('SELECT mp.* AS count \
              FROM "modulePermission" mp \
              JOIN "user" u ON u.id=$1 \
              WHERE mp."moduleID"=$2 and mp."roleID"=u."roleID"', [userID, moduleID], qrm.one).then(function (data) {
        if (data) {
            return callback();
        }
        return failedCallback(req, res);
    }).catch(function (error) {
        return failedCallback(req, res);
    });
}


function renderView(sourceFile, jsonObj, callback) {
    fs.readFile(sourceFile, function(err, data){
        if (!err) {
            // make the buffer into a string
            var source = data.toString();
            // call the render function
            callback(200, renderToString(source, jsonObj));
        } else {
            // handle file read error
            callback(500, "Error occured on server when rendering view.");
        }
    });
}

function renderToString(source, data) {
    var template = handlebars.compile(source);
    var outputString = template(data);
    return outputString;
}


/*
 * Visit the home page.
 */
app.get('/', function (req, res) {
    if (req.isAuthenticated()) {
        res.redirect('/questions/0');
    } else {
        res.redirect('/login');
    };
});
/*
 * Login page.
 */
app.get('/login', function (req, res) {
    fs.readFile(__dirname + '/views/header.html', function(err, data){
        renderView(__dirname + '/views/index.html', {header:data,message:'Please log in'}, function(code, str) {
            res.writeHead(code); res.end(str);
        });
    });
});
/*
 * Login.
 */
app.post('/login', function(req, res, next) {
    passport.authenticate('local', function(err, user, info) {
        if (err) {
            return next(err);
        }
        if (!user) {
            fs.readFile(__dirname + '/views/header.html', function(err, data){
                renderView(__dirname + '/views/index.html', {header:data,message:NO_USER_FOUND_MESSAGE}, function(code, str) {
                    res.writeHead(code); res.end(str);
                });
            });
        } else {
            // Manually establish the session...
            req.login(user, function(err) {
                if (err) {
                    return next(err);
                }
                res.redirect('/questions/0');
            });
        }
    })(req, res, next);
});
/*
 * Logout page.
 */
app.get('/logout', function(req, res, next) {
    if (req.isAuthenticated()) {
        next();
    } else {
        res.redirect('/login');
    };
}, function (req, res) {
    req.logout();
    res.redirect('/login');
});
/*
 * Forgot password.
 */
app.get('/forgetpassword', function (req, res) {
	fs.readFile(__dirname + '/views/header.html', function(err, data){
		renderView(__dirname + '/views/forgotpassword.html', {header:data}, function(code, str) {
			res.writeHead(code); res.end(str);
		});
	});
});
/*
 * User registration.
 */
app.get('/register', function (req, res) {
	fs.readFile(__dirname + '/views/header.html', function(err, data){
		renderView(__dirname + '/views/register.html', {header:data}, function(code, str) {
			res.writeHead(code); res.end(str);
		});
	});
});
/*
 * User registration.
 */
app.post('/register', function(req, res, next) {
    next();
}, function (req, res) {
    var email = req.body.email;
    var username = req.body.username;
    var password = req.body.password;
    var password2 = req.body.password2;
    db.query('INSERT INTO "user" (email, password, "roleID", username) VALUES ($1, $2, 1, $3) RETURNING id', [email,password,username], qrm.one).then(function (data) {
        res.redirect('/login');
    }).catch(function (error) {
		fs.readFile(__dirname + '/views/header.html', function(err, data){
			renderView(__dirname + '/views/register.html', {header:data,message:error}, function(code, str) {
				res.writeHead(code); res.end(str);
			});
		});
    });
});
/*
 * Get public questions.
 */
app.get('/questions/:page(\\d+)', function(req, res, next) {
    if (req.isAuthenticated()) {
        var userID = req.session.passport.user;
        checkPermission(req, res, userID, 1, next, function(req, res) {
            return res.status(403).jsonp({message: PERMISSION_DENIED_MESSAGE});
        });
    } else {
        res.redirect('/');
    };
}, function (req, res) {
	var userID = req.session.passport.user;
	var page = parseInt(req.params.page, 10);
    var offset = page * page_size;
    db.query('SELECT q.*,user_id=$1 mine,u.username FROM question q JOIN "user" u ON q.user_id=u.id ORDER BY date_created desc LIMIT $2 OFFSET $3', [userID, page_size, offset], qrm.any).then(function (sqldata) {
        fs.readFile(__dirname + '/views/header.html', function(err, data){
            renderView(__dirname + '/views/page.html', {
                header : data,
                questions : sqldata,
				page : page,
				nextpage : page + 1,
				prevpage : page - 1,
				title : 'All Questions'
            }, function(code, str) {
                res.writeHead(code); res.end(str);
            });
        });
    }).catch(function (error) {
        res.writeHead(403); 
        res.end(JSON.stringify(error));
    });
});

/*
 * Get my questions.
 */
app.get('/questions/mine/:page(\\d+)', function(req, res, next) {
    if (req.isAuthenticated()) {
        var userID = req.session.passport.user;
        checkPermission(req, res, userID, 1, next, function(req, res) {
            return res.status(403).jsonp({message: PERMISSION_DENIED_MESSAGE});
        });
    } else {
        res.redirect('/login');
    };
}, function (req, res) {
    var userID = req.session.passport.user;
	var page = parseInt(req.params.page, 10);
    var offset = page * page_size;
    db.query('SELECT *,user_id=$1 mine,u.username FROM question q JOIN "user" u ON q.user_id=u.id WHERE user_id=$1 ORDER BY date_created desc LIMIT $2 OFFSET $3', [userID, page_size, offset], qrm.any).then(function (sqldata) {        
		fs.readFile(__dirname + '/views/header.html', function(err, data){
            renderView(__dirname + '/views/page.html', {
                header : data,
                questions : sqldata,
				page : page,
				nextpage : page + 1,
				prevpage : page - 1,
				title : 'My Questions'
            }, function(code, str) {
                res.writeHead(code); res.end(str);
            });
        }); 
    }).catch(function (error) {
        res.writeHead(403); 
        res.end(JSON.stringify(error));
    });
});
/*
 * Get a question.
 */
app.get('/questions/:questionID(\\d+)', function(req, res, next) {
    if (req.isAuthenticated()) {
        var userID = req.session.passport.user;
        checkPermission(req, res, userID, 1, next, function(req, res) {
            return res.status(403).jsonp({message: PERMISSION_DENIED_MESSAGE});
        });
    } else {
        res.redirect('/login');
    };
}, function (req, res) {
    var questionID = parseInt(req.params.questionID, 10);
    db.query('SELECT * from question where id=$1', questionID, qrm.one).then(function (data) {
        res.end(JSON.stringify({
            "question" : data
        }));
    }).catch(function (error) {
        res.writeHead(403); 
        res.end(JSON.stringify(error));
    });
});
/*
 * Edit a question.
 */
app.post('/questions/:questionID(\\d+)', function(req, res, next) {
    if (req.isAuthenticated()) {
        var userID = req.session.passport.user;
        checkPermission(req, res, userID, 1, next, function(req, res) {
            return res.status(403).jsonp({message: PERMISSION_DENIED_MESSAGE});
        });
    } else {
        return res.status(403).jsonp({message: NOT_AUTHENTICATED_MESSAGE});
    };
}, function (req, res) {
    var userID = req.session.passport.user;
    var question = req.body.question;
    var questionID = parseInt(req.params.questionID, 10);
    db.query('UPDATE question set question=$1,date_modified=now() WHERE id=$2 and user_id=$3', [question,questionID,userID], qrm.none).then(function () {
        res.end(JSON.stringify({
        }));
    }).catch(function (error) {
        res.writeHead(403); 
        res.end(JSON.stringify(error));
    });
});
/*
 * Create a question.
 */
app.post('/questions', function(req, res, next) {
    if (req.isAuthenticated()) {
        var userID = req.session.passport.user;
        checkPermission(req, res, userID, 1, next, function(req, res) {
            return res.status(403).jsonp({message: PERMISSION_DENIED_MESSAGE});
        });
    } else {
        return res.status(403).jsonp({message: NOT_AUTHENTICATED_MESSAGE});
    };
}, function (req, res) {
    var userID = req.session.passport.user;
    var question = req.body.question;
    db.query('INSERT INTO question (question,date_created,date_modified,user_id,yes,no) \
              VALUES ($1,now(),now(),$2,0,0) RETURNING id', [question, userID], qrm.one).then(function (data) {
        res.end(JSON.stringify({
            "id" : data.id
        }));
    }).catch(function (error) {
        res.writeHead(403); 
        res.end(JSON.stringify(error));
    });
});
/*
 * Delete a question.
 */
app.post('/questions/:questionID(\\d+)/delete', function(req, res, next) {
    if (req.isAuthenticated()) {
        var userID = req.session.passport.user;
        checkPermission(req, res, userID, 1, next, function(req, res) {
            return res.status(403).jsonp({message: PERMISSION_DENIED_MESSAGE});
        });
    } else {
        return res.status(403).jsonp({message: NOT_AUTHENTICATED_MESSAGE});
    };
}, function (req, res) {
    var userID = req.session.passport.user;
    var questionID = parseInt(req.params.questionID, 10);
    db.query('DELETE FROM question WHERE id=$1 and user_id=$2', [questionID,userID], qrm.none).then(function () {
        res.end(JSON.stringify({
        }));
    }).catch(function (error) {
        res.writeHead(403); 
        res.end(JSON.stringify(error));
    });
});
/*
 * Vote yes on a question.
 */
app.post('/questions/:questionID(\\d+)/yes', function(req, res, next) {
    if (req.isAuthenticated()) {
        var userID = req.session.passport.user;
        checkPermission(req, res, userID, 1, next, function(req, res) {
            return res.status(403).jsonp({message: PERMISSION_DENIED_MESSAGE});
        });
    } else {
        return res.status(403).jsonp({message: NOT_AUTHENTICATED_MESSAGE});
    };
}, function (req, res) {
    var userID = req.session.passport.user;
    var questionID = parseInt(req.params.questionID, 10);
    db.query('UPDATE question set yes=yes+1 WHERE id=$1 and user_id!=$2', [questionID,userID], qrm.none).then(function () {
        res.end(JSON.stringify({
        }));
    }).catch(function (error) {
        res.writeHead(403); 
        res.end(JSON.stringify(error));
    });
});
/*
 * Vote no on a question.
 */
app.post('/questions/:questionID(\\d+)/no', function(req, res, next) {
    if (req.isAuthenticated()) {
        var userID = req.session.passport.user;
        checkPermission(req, res, userID, 1, next, function(req, res) {
            return res.status(403).jsonp({message: PERMISSION_DENIED_MESSAGE});
        });
    } else {
        return res.status(403).jsonp({message: NOT_AUTHENTICATED_MESSAGE});
    };
}, function (req, res) {
    var userID = req.session.passport.user;
    var questionID = parseInt(req.params.questionID, 10);
    db.query('UPDATE question set no=no+1 WHERE id=$1 and user_id!=$2', [questionID,userID], qrm.none).then(function () {
        res.end(JSON.stringify({
        }));
    }).catch(function (error) {
        res.writeHead(403); 
        res.end(JSON.stringify(error));
    });
});




var server = app.listen(process.env.PORT || 3000, function () {
    var host = server.address().address;
    var port = server.address().port;

    console.log('QuickyHealth started at http://%s:%s', host, port);
});

var io = socket.listen(server);
io.on('connection', function(socket){
    console.log('a user connected');

    socket.on('disconnect', function() {
        console.log('a user left');
    });
});